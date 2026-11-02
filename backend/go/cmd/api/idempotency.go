package main

import (
 "context"
 "bytes"
 "crypto/sha256"
 "encoding/hex"
 "io"
 "database/sql"
 "encoding/json"
 "errors"
 "fmt"
 "net/http"
 "strings"
)

type bodyHashContextKey struct{}
type cachedResponse struct { Status int `json:"status"`; Body json.RawMessage `json:"body"` }
var errIdempotencyConflict=errors.New("idempotency key was already used with a different request")
func requireIdempotencyKey(r *http.Request)(string,string,error){key:=strings.TrimSpace(r.Header.Get("Idempotency-Key"));if key==""||len(key)>255{return "","",errors.New("a valid Idempotency-Key header is required")};hash,_:=r.Context().Value(bodyHashContextKey{}).(string);if hash==""{body,err:=io.ReadAll(io.LimitReader(r.Body,(1<<20)+1));if err!=nil||len(body)>1<<20{return "","",errors.New("unable to hash request body")};_ = r.Body.Close();r.Body=io.NopCloser(bytes.NewReader(body));fingerprint:=r.Method+"\n"+r.URL.EscapedPath()+"\n";sum:=sha256.Sum256(append([]byte(fingerprint),body...));hash=hex.EncodeToString(sum[:])};return key,hash,nil}
func reserveIdempotency(ctx context.Context,tx *sql.Tx,org,key,hash string)(int,[]byte,bool,error){res,err:=tx.ExecContext(ctx,`INSERT INTO idempotency_records(organization_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,'{"status":0,"body":{}}'::jsonb) ON CONFLICT(organization_id,idempotency_key) DO NOTHING`,org,key,hash);if err!=nil{return 0,nil,false,err};n,_:=res.RowsAffected();if n==1{return 0,nil,false,nil};var previousHash string;var payload []byte;if err=tx.QueryRowContext(ctx,`SELECT request_hash,response FROM idempotency_records WHERE organization_id=$1 AND idempotency_key=$2 FOR UPDATE`,org,key).Scan(&previousHash,&payload);err!=nil{return 0,nil,false,err};if previousHash!=hash{return 0,nil,false,errIdempotencyConflict};var cached cachedResponse;if err=json.Unmarshal(payload,&cached);err!=nil||cached.Status==0||len(cached.Body)==0{return 0,nil,false,fmt.Errorf("idempotency response is incomplete")};return cached.Status,cached.Body,true,nil}
func storeIdempotency(ctx context.Context,tx *sql.Tx,org,key string,status int,body any)error{encoded,err:=json.Marshal(body);if err!=nil{return err};envelope,err:=json.Marshal(cachedResponse{Status:status,Body:encoded});if err!=nil{return err};_,err=tx.ExecContext(ctx,`UPDATE idempotency_records SET response=$3::jsonb WHERE organization_id=$1 AND idempotency_key=$2 AND response->>'status'='0'`,org,key,string(envelope));return err}
func writeRawJSON(w http.ResponseWriter,status int,body []byte){w.Header().Set("Content-Type","application/json");w.WriteHeader(status);_,_=w.Write(append(body,'\n'))}
func idempotencyFailure(w http.ResponseWriter,r *http.Request,err error){if errors.Is(err,errIdempotencyConflict){writeJSON(w,409,problem{Error:err.Error(),RequestID:requestID(r)});return};writeJSON(w,500,problem{Error:"idempotency record failure",RequestID:requestID(r)})}
