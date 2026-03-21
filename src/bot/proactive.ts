import {
  CardFactory,
  CloudAdapter,
  ConversationReference,
} from "botbuilder";
import { infoCard } from "../cards/templates.js";

/**
 * Sends proactive messages to Teams channels.
 * Used for operational alerts (health failures, order thresholds, etc.)
 */
export class ProactiveMessenger {
  constructor(
    private readonly adapter: CloudAdapter,
    private readonly appId: string
  ) {}

  /**
   * Send a proactive Adaptive Card to a conversation.
   */
  async sendCard(
    conversationRef: Partial<ConversationReference>,
    card: Record<string, unknown>
  ): Promise<void> {
    await this.adapter.continueConversationAsync(
      this.appId,
      conversationRef,
      async (context) => {
        await context.sendActivity({
          attachments: [CardFactory.adaptiveCard(card)],
        });
      }
    );
  }

  /**
   * Send a simple text message to a conversation.
   */
  async sendText(
    conversationRef: Partial<ConversationReference>,
    text: string
  ): Promise<void> {
    await this.adapter.continueConversationAsync(
      this.appId,
      conversationRef,
      async (context) => {
        await context.sendActivity(text);
      }
    );
  }

  /**
   * Send an alert to all stored conversation references.
   */
  async broadcastAlert(
    conversations: Map<string, Partial<ConversationReference>>,
    title: string,
    body: string,
    facts?: Array<{ title: string; value: string }>
  ): Promise<void> {
    const card = infoCard(title, body, facts);
    for (const ref of conversations.values()) {
      try {
        await this.sendCard(ref, card);
      } catch (error) {
        console.error(
          `Failed to send proactive message to ${ref.conversation?.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }
}
