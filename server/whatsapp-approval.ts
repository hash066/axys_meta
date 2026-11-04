import { z } from "zod";
import { equal, sign } from "./security.ts";
import type { Store } from "./store.ts";

// Native WhatsApp reply buttons. A button id is an HMAC-signed token bound to
// the exact campaign version, so a reply can never act on a different campaign
// or on content that changed after the button was sent. Tapping "Approve" only
// records the merchant's intent; publication still requires the exact-digest
// approval in Studio (account and schedule are not chosen in WhatsApp).

export type ApprovalAction = "approve" | "changes" | "preview";

export type ApprovalSubject = {
  tenant: string;
  campaignId: string;
  revision: number;
  siteHash: string;
  videoHash: string;
};

export type WhatsAppDecision = ApprovalSubject & {
  id: string;
  action: ApprovalAction;
  messageId: string;
  sender: string;
  status: "Recorded" | "Applied";
  receivedAt: string;
};

const ACTIONS: ApprovalAction[] = ["approve", "changes", "preview"];
const TITLES: Record<ApprovalAction, string> = {
  approve: "Approve",
  changes: "Request changes",
  preview: "Open preview",
};

function subjectKey(subject: ApprovalSubject) {
  return [
    subject.tenant,
    subject.campaignId,
    subject.revision,
    subject.siteHash,
    subject.videoHash,
  ].join("|");
}

// WhatsApp limits a button id to 256 characters.
export function buttonId(
  subject: ApprovalSubject,
  action: ApprovalAction,
  secret: string,
) {
  const mac = sign(`${action}|${subjectKey(subject)}`, secret).slice(0, 32);
  return `ax1.${action}.${subject.campaignId}.${subject.revision}.${mac}`;
}

export function approvalButtons(
  to: string,
  subject: ApprovalSubject,
  summary: string,
  secret: string,
) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: summary.slice(0, 1024) },
      action: {
        buttons: ACTIONS.map((action) => ({
          type: "reply",
          reply: {
            id: buttonId(subject, action, secret),
            title: TITLES[action],
          },
        })),
      },
    },
  };
}

const Reply = z.object({
  type: z.literal("interactive"),
  interactive: z.object({
    type: z.literal("button_reply"),
    button_reply: z.object({ id: z.string().max(256) }),
  }),
});

// Returns the action and campaign the id claims, or undefined if malformed.
export function parseButtonId(id: string) {
  const match = /^ax1\.(approve|changes|preview)\.([\w-]{1,64})\.(\d{1,9})\.([0-9a-f]{32})$/.exec(
    id,
  );
  if (!match) return;
  return {
    action: match[1] as ApprovalAction,
    campaignId: match[2],
    revision: Number(match[3]),
    mac: match[4],
  };
}

export function verifyButtonReply(
  message: unknown,
  subject: ApprovalSubject,
  secret: string,
): ApprovalAction | undefined {
  const parsed = Reply.safeParse(message);
  if (!parsed.success) return;
  const claim = parseButtonId(parsed.data.interactive.button_reply.id);
  if (
    !claim ||
    claim.campaignId !== subject.campaignId ||
    claim.revision !== subject.revision
  )
    return;
  const expected = buttonId(subject, claim.action, secret);
  return equal(expected, parsed.data.interactive.button_reply.id)
    ? claim.action
    : undefined;
}

export function recordDecision(
  store: Store,
  subject: ApprovalSubject,
  action: ApprovalAction,
  messageId: string,
  sender: string,
): WhatsAppDecision | undefined {
  const id = `${subject.campaignId}:${messageId}`;
  if (store.get("whatsapp-decision", subject.tenant, id)) return;
  const decision: WhatsAppDecision = {
    ...subject,
    id,
    action,
    messageId,
    sender,
    status: "Recorded",
    receivedAt: new Date().toISOString(),
  };
  store.put("whatsapp-decision", subject.tenant, id, decision);
  return decision;
}
