"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { currencyFractionDigits, formatMinor, minorToMajorInput } from "@/lib/format";
import type { Customer, InvoiceLine } from "@/lib/types";

/** Line items as typed: amounts in major units, as strings. */
export type DraftLine = { description: string; quantity: string; unit: string };

export type InvoiceDraft = {
  customerId: string;
  currency: string;
  lines: DraftLine[];
  taxPercent: string;
  dueDate: string;
  notes: string;
};

export const emptyLine: DraftLine = { description: "", quantity: "1", unit: "" };

export function draftFromLines(lines: InvoiceLine[], currency: string): DraftLine[] {
  return lines.map((line) => ({
    description: line.description,
    quantity: String(line.quantity),
    unit: minorToMajorInput(line.unit_amount, currency)
  }));
}

function toMinor(value: string, currency: string): number | null {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) return null;
  const minor = Math.round(parsed * 10 ** currencyFractionDigits(currency));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Checks a draft and turns it into API line items, tax and totals. */
export function priceDraft(draft: InvoiceDraft) {
  const currency = draft.currency.trim().toUpperCase();
  const errors: string[] = [];
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("Enter a three-letter currency code.");
  const lines: InvoiceLine[] = [];
  let subtotal = 0;
  draft.lines.forEach((line, index) => {
    const quantity = Number(line.quantity);
    const unit = toMinor(line.unit, currency || "USD");
    if (!line.description.trim()) errors.push(`Line ${index + 1} needs a description.`);
    if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`Line ${index + 1} needs a quantity above 0.`);
    if (unit == null) errors.push(`Line ${index + 1} needs a price.`);
    if (unit != null && quantity > 0) {
      const amount = Math.round(quantity * unit);
      subtotal += amount;
      lines.push({ description: line.description.trim(), quantity, unit_amount: unit, amount });
    }
  });
  const taxPercent = draft.taxPercent.trim() ? Number(draft.taxPercent) : 0;
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) errors.push("Tax must be between 0 and 100%.");
  const taxBps = Math.round((Number.isFinite(taxPercent) ? taxPercent : 0) * 100);
  const tax = Math.round((subtotal * taxBps) / 10000);
  if (errors.length === 0 && subtotal + tax <= 0) errors.push("The total must be above zero.");
  return { currency, lines, taxBps, subtotal, tax, total: subtotal + tax, errors };
}

export function InvoiceFields({
  draft,
  onChange,
  customers,
  requireCustomer,
  showDueDate = true
}: {
  draft: InvoiceDraft;
  onChange: (draft: InvoiceDraft) => void;
  customers: Customer[];
  requireCustomer?: boolean;
  showDueDate?: boolean;
}) {
  const priced = priceDraft(draft);
  const currency = priced.currency || "USD";
  const setLine = (index: number, patch: Partial<DraftLine>) =>
    onChange({ ...draft, lines: draft.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
        <div className="space-y-2">
          <Label htmlFor="invoice-customer">Customer{requireCustomer ? "" : " (optional)"}</Label>
          <select
            id="invoice-customer"
            value={draft.customerId}
            required={requireCustomer}
            onChange={(event) => onChange({ ...draft, customerId: event.target.value })}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12px]"
          >
            <option value="">{requireCustomer ? "Choose a customer" : "No customer"}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
                {customer.email ? ` · ${customer.email}` : " · no email"}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-currency">Currency</Label>
          <Input
            id="invoice-currency"
            value={draft.currency}
            maxLength={3}
            required
            onChange={(event) => onChange({ ...draft, currency: event.target.value.toUpperCase().slice(0, 3) })}
            className="h-9 font-mono text-[12px]"
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[12px] font-medium text-ink-900">Lines</legend>
        <div className="hidden grid-cols-[1fr_64px_100px_28px] gap-2 text-[10.5px] text-ink-400 sm:grid">
          <span>Description</span>
          <span>Qty</span>
          <span>Unit price</span>
          <span />
        </div>
        {draft.lines.map((line, index) => (
          <div key={index} className="grid grid-cols-[1fr_64px_100px_28px] items-center gap-2">
            <Input
              aria-label={`Line ${index + 1} description`}
              value={line.description}
              maxLength={300}
              placeholder="What you are charging for"
              onChange={(event) => setLine(index, { description: event.target.value })}
              className="h-9 text-[12px]"
            />
            <Input
              aria-label={`Line ${index + 1} quantity`}
              type="number"
              min="0"
              step="any"
              value={line.quantity}
              onChange={(event) => setLine(index, { quantity: event.target.value })}
              className="h-9 px-2 font-mono text-[12px]"
            />
            <Input
              aria-label={`Line ${index + 1} unit price`}
              type="number"
              min="0"
              step="any"
              value={line.unit}
              placeholder="0.00"
              onChange={(event) => setLine(index, { unit: event.target.value })}
              className="h-9 px-2 font-mono text-[12px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Remove line ${index + 1}`}
              disabled={draft.lines.length === 1}
              onClick={() => onChange({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-[11.5px]"
          disabled={draft.lines.length >= 100}
          onClick={() => onChange({ ...draft, lines: [...draft.lines, { ...emptyLine }] })}
        >
          <Plus className="size-3.5" />
          Add line
        </Button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-tax">Tax (%)</Label>
          <Input
            id="invoice-tax"
            type="number"
            min="0"
            max="100"
            step="any"
            placeholder="0"
            value={draft.taxPercent}
            onChange={(event) => onChange({ ...draft, taxPercent: event.target.value })}
            className="h-9 font-mono text-[12px]"
          />
          <p className="text-[10.5px] text-ink-400">For example 18 for VAT at 18%.</p>
        </div>
        {showDueDate && (
          <div className="space-y-2">
            <Label htmlFor="invoice-due">Due date</Label>
            <Input
              id="invoice-due"
              type="date"
              value={draft.dueDate}
              onChange={(event) => onChange({ ...draft, dueDate: event.target.value })}
              className="h-9 text-[12px]"
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="invoice-notes">Notes for the customer (optional)</Label>
        <Textarea
          id="invoice-notes"
          value={draft.notes}
          maxLength={2000}
          rows={2}
          onChange={(event) => onChange({ ...draft, notes: event.target.value })}
          className="text-[12px]"
        />
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-lg border border-border bg-paper px-4 py-3 text-[12px]">
        <dt className="text-ink-500">Subtotal</dt>
        <dd className="text-right font-mono text-ink-800">{formatMinor(priced.subtotal, currency)}</dd>
        <dt className="text-ink-500">Tax</dt>
        <dd className="text-right font-mono text-ink-800">{formatMinor(priced.tax, currency)}</dd>
        <dt className="font-semibold text-ink-950">Total</dt>
        <dd className="text-right font-mono font-semibold text-ink-950">{formatMinor(priced.total, currency)}</dd>
      </dl>
    </div>
  );
}
