package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// Secrets at rest (webhook signing secrets, TOTP seeds) are sealed with
// AES-256-GCM under a purpose-specific subkey derived with HKDF from a
// versioned master key.
//
// Ciphertext layout: "AEK1" | len(keyID) | keyID | nonce | sealed.
// The key ID and purpose are authenticated as additional data, so a ciphertext
// cannot be replayed under another purpose or key.
//
// ENCRYPTION_KEYS holds "id:hex" pairs separated by commas; the first key
// seals new secrets and every listed key can open existing ones. When it is
// unset, WEBHOOK_ENCRYPTION_KEY becomes the single key with ID "legacy".
// Ciphertexts written before key versioning (nonce | sealed, using
// WEBHOOK_ENCRYPTION_KEY directly) remain readable, and the maintenance job
// re-seals them and anything under a retired key with the active key.

const (
	purposeWebhookSecret = "webhook-signing-secret"
	purposeMFASecret     = "mfa-totp-secret"
)

var secretBoxMagic = []byte("AEK1")

type secretKeyRing struct {
	activeID string
	keys     map[string][]byte
	legacy   []byte
}

var (
	keyRingOnce   sync.Once
	keyRingLoaded *secretKeyRing
	keyRingErr    error
	keyIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

func loadKeyRing() (*secretKeyRing, error) {
	keyRingOnce.Do(func() {
		keyRingLoaded, keyRingErr = parseKeyRing(env("ENCRYPTION_KEYS", ""), env("WEBHOOK_ENCRYPTION_KEY", ""))
	})
	return keyRingLoaded, keyRingErr
}

func decodeMasterKey(value string) ([]byte, error) {
	key, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(key) != 32 {
		return nil, errors.New("encryption keys must be 32 bytes encoded as 64 hex characters")
	}
	return key, nil
}

func parseKeyRing(keysValue, legacyValue string) (*secretKeyRing, error) {
	ring := &secretKeyRing{keys: map[string][]byte{}}
	if strings.TrimSpace(legacyValue) != "" {
		key, err := decodeMasterKey(legacyValue)
		if err != nil {
			return nil, fmt.Errorf("WEBHOOK_ENCRYPTION_KEY: %w", err)
		}
		ring.legacy = key
	}
	for _, entry := range strings.Split(keysValue, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		id, value, ok := strings.Cut(entry, ":")
		if !ok || !keyIDPattern.MatchString(id) {
			return nil, errors.New("ENCRYPTION_KEYS entries must look like id:hex, with an id of letters, digits, _ or -")
		}
		key, err := decodeMasterKey(value)
		if err != nil {
			return nil, fmt.Errorf("ENCRYPTION_KEYS %s: %w", id, err)
		}
		if _, dup := ring.keys[id]; dup {
			return nil, fmt.Errorf("ENCRYPTION_KEYS lists key %s twice", id)
		}
		ring.keys[id] = key
		if ring.activeID == "" {
			ring.activeID = id
		}
	}
	// Secrets sealed while WEBHOOK_ENCRYPTION_KEY was the only key carry the ID
	// "legacy"; keep it readable after ENCRYPTION_KEYS is introduced.
	if _, defined := ring.keys["legacy"]; !defined && ring.legacy != nil {
		ring.keys["legacy"] = ring.legacy
	}
	if ring.activeID == "" && ring.legacy != nil {
		ring.activeID = "legacy"
	}
	if ring.activeID == "" {
		return nil, errors.New("secret encryption is not configured; set ENCRYPTION_KEYS or WEBHOOK_ENCRYPTION_KEY")
	}
	return ring, nil
}

func (k *secretKeyRing) aead(id, purpose string) (cipher.AEAD, error) {
	master, ok := k.keys[id]
	if !ok {
		return nil, fmt.Errorf("encryption key %q is not configured", id)
	}
	subkey, err := hkdf.Key(sha256.New, master, nil, "aegispay "+purpose, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(subkey)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// activeHeader is the ciphertext prefix produced by the active key. Rows that
// do not start with it need re-encryption.
func (k *secretKeyRing) activeHeader() []byte {
	header := append([]byte{}, secretBoxMagic...)
	header = append(header, byte(len(k.activeID)))
	return append(header, k.activeID...)
}

func (k *secretKeyRing) seal(purpose string, plaintext []byte) ([]byte, error) {
	gcm, err := k.aead(k.activeID, purpose)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	header := k.activeHeader()
	out := append(header, nonce...)
	return gcm.Seal(out, nonce, plaintext, additionalData(purpose, k.activeID)), nil
}

func (k *secretKeyRing) open(purpose string, ciphertext []byte) ([]byte, error) {
	if bytes.HasPrefix(ciphertext, secretBoxMagic) && len(ciphertext) > len(secretBoxMagic) {
		rest := ciphertext[len(secretBoxMagic):]
		idLen := int(rest[0])
		if idLen > 0 && len(rest) > idLen {
			id := string(rest[1 : 1+idLen])
			body := rest[1+idLen:]
			if gcm, err := k.aead(id, purpose); err == nil && len(body) >= gcm.NonceSize() {
				nonce := body[:gcm.NonceSize()]
				if plain, err := gcm.Open(nil, nonce, body[gcm.NonceSize():], additionalData(purpose, id)); err == nil {
					return plain, nil
				}
			}
		}
	}
	// Pre-versioning format: nonce | sealed under the raw legacy key.
	if k.legacy == nil {
		return nil, errors.New("secret could not be decrypted with the configured keys")
	}
	block, err := aes.NewCipher(k.legacy)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, errors.New("invalid encrypted secret")
	}
	return gcm.Open(nil, ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():], nil)
}

func additionalData(purpose, id string) []byte {
	return []byte("aegispay:" + purpose + ":" + id)
}

func sealSecret(purpose, secret string) ([]byte, error) {
	ring, err := loadKeyRing()
	if err != nil {
		return nil, err
	}
	return ring.seal(purpose, []byte(secret))
}

func openSecret(purpose string, ciphertext []byte) (string, error) {
	ring, err := loadKeyRing()
	if err != nil {
		return "", err
	}
	plain, err := ring.open(purpose, ciphertext)
	return string(plain), err
}
