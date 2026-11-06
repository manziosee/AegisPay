"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import { FormDialog } from "@/components/ui-blocks/form-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { SUPPORT_EMAIL } from "@/lib/site";

export function FeedbackButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <>
      <Button variant="ghost" size="sm" className="h-8 text-[11.5px] text-ink-500" onClick={() => setOpen(true)}>
        <MessageCircleQuestion className="size-3.5" />
        <span className="hidden sm:inline">Help &amp; feedback</span>
        <span className="sr-only sm:hidden">Help and feedback</span>
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Help & feedback"
        description={`Tell us what's wrong or what you'd like. We reply by email. You can also write to ${SUPPORT_EMAIL}.`}
        submitLabel="Send"
        onSubmit={async () => {
          if (!message.trim()) throw new Error("Write a short message first.");
          await api("/feedback", { method: "POST", body: JSON.stringify({ message: message.trim(), page: pathname }) });
          setMessage("");
          toast.success("Thanks. Your message was sent.");
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="feedback-message">Message</Label>
          <Textarea id="feedback-message" required maxLength={4000} rows={5} value={message} onChange={(event) => setMessage(event.target.value)} />
        </div>
      </FormDialog>
    </>
  );
}
