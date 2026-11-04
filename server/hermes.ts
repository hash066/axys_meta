import { z } from "zod";
import { hash } from "../packages/campaign/index.ts";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import {
  saveWhatsAppMessage,
  type WhatsAppDraft,
  type WhatsAppMedia,
} from "./whatsapp.ts";

const Command = z
  .object({
    action: z.enum(["intake", "draft", "status", "prepare"]),
    context: z
      .object({
        platform: z.literal("whatsapp_cloud"),
        userId: z.string().regex(/^\d{8,15}$/),
        messageId: z.string().min(3).max(512),
      })
      .strict(),
    payload: z
      .object({
        text: z.string().max(6000).optional(),
        campaignId: z.string().uuid().optional(),
        media: z
          .array(
            z
              .object({
                id: z.string().min(1).max(512),
                type: z.enum(["image", "audio", "video", "document"]),
                caption: z.string().max(1024).optional(),
              })
              .strict(),
          )
          .max(12)
          .optional(),
      })
      .strict(),
  })
  .strict();

// Only the trusted gateway supplies context; model arguments cannot choose a tenant.
export function hermesCommand(
  store: Store,
  input: unknown,
  mapping: Record<string, string>,
) {
  const command = Command.parse(input);
  const tenant = mapping[command.context.userId];
  if (!tenant || !/^[\w-]{1,64}$/.test(tenant))
    throw new Error("Sender is not linked");
  const sender = hash(command.context.userId);
  if (command.action === "intake") {
    if (!command.payload.text?.trim() && !command.payload.media?.length)
      throw new Error("Text or media is required");
    let accepted = 0;
    if (command.payload.text?.trim())
      accepted += Number(
        saveWhatsAppMessage(store, tenant, {
          id: command.context.messageId,
          from: command.context.userId,
          type: "text",
          text: { body: command.payload.text },
        }),
      );
    for (const [index, media] of (command.payload.media || []).entries())
      accepted += Number(
        saveWhatsAppMessage(store, tenant, {
          id: `${command.context.messageId}:media:${index}`,
          from: command.context.userId,
          type: media.type,
          [media.type]: { id: media.id, caption: media.caption },
        }),
      );
    return {
      status: "accepted",
      accepted,
      customerMessage: "Your details are saved in Axys Studio for review.",
    };
  }
  if (command.action === "draft") {
    const draft = store.get<WhatsAppDraft>("whatsapp-draft", tenant, sender);
    if (!draft)
      return {
        status: "accepted",
        draft: null,
        customerMessage: "Send your business details and owned media to begin.",
      };
    return {
      status: "accepted",
      draft: {
        brief: draft.brief,
        mode: draft.mode,
        media: draft.media.map((item) => ({
          kind: item.kind,
          status: item.status,
        })),
        needsConfirmation: true,
      },
      customerMessage:
        "Your WhatsApp draft is saved. Confirm the required facts and media in Axys Studio before generation.",
    };
  }
  const engine = new Engine(store);
  if (command.action === "prepare") {
    if (!command.payload.campaignId) throw new Error("Campaign is required");
    const c = engine.get(tenant, command.payload.campaignId);
    // Reuse the durable local renderer only; this tool cannot approve, publish or spend.
    if (c.state === "Draft") {
      store.transaction(() => {
        c.state = "Generating";
        engine.save(c);
        engine.enqueue(c, "generate");
      });
    }
    return {
      status: "accepted",
      customerMessage:
        "Check the campaign preview in Axys Studio. Publishing requires your approval there.",
      campaignId: c.id,
      state: c.state,
    };
  }
  return {
    status: "accepted",
    intake: store.list("intake", tenant).length,
    pendingMedia: store
      .list<WhatsAppMedia>("whatsapp-media", tenant)
      .filter((item) => item.status === "PendingFetch").length,
    campaigns: store
      .list<{ id: string; state: string; revision: number }>("campaign", tenant)
      .map((c) => ({ id: c.id, state: c.state, revision: c.revision })),
  };
}
