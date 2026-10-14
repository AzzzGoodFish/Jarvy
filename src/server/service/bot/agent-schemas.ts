import { Type } from "typebox";

const None = Type.Object({}, { additionalProperties: false });
const Name = Type.String({ minLength: 1, maxLength: 80, description: "Unique among all members, people and Bots" });
const BotName = Type.String({ minLength: 1, maxLength: 80, description: "The Bot's name, as bots.list shows it" });
const Model = Type.Object({
  connection: Type.String({ minLength: 1, maxLength: 200, description: "A connection's name or ID from models.list" }),
  model: Type.String({ minLength: 1, maxLength: 200, description: "A model's ID or name in that connection" }),
}, { additionalProperties: false });
const Thinking = Type.Union(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level)),
  { description: "How much the model thinks; auto lets Jarvy choose. models.list gives the levels each model has" });
const Settings = {
  description: Type.Optional(Type.String({ maxLength: 1000, description: "One line that other members see in members.list" })),
  persona: Type.Optional(Type.String({ maxLength: 16_000, description: "Its standing instructions: who it is and how it works (the Persona section of its prompt)" })),
  model: Type.Optional(Model), thinking: Type.Optional(Thinking),
};
/** A deletion first asks the owner on a card (A48); the agent words it in the owner's language. */
const Confirm = {
  askIn: Type.String({ description: "ID of a chat the owner is in, where the confirmation card goes; usually the chat you were asked in" }),
  question: Type.String({ minLength: 1, maxLength: 500, description: "The card's question, in the owner's language: what will be deleted and what goes with it" }),
  confirm: Type.String({ minLength: 1, maxLength: 40, description: "Label of the button that deletes, in the owner's language" }),
  cancel: Type.String({ minLength: 1, maxLength: 40, description: "Label of the button that keeps everything, in the owner's language" }),
};
const after = "The owner first gets a card in askIn, and nothing is deleted unless they confirm; the result says what they chose.";

/** The agent Bot's own tools behind the `chat` gateway (A48); only it lists them, and a call from another Bot is an
 * unknown tool. Descriptions are what the agent reads. */
export const agentDefinitions = {
  "models.list": { description: "List the models you can give a Bot: each connection with its models and their thinking levels. Only the owner adds connections, keys and logins, in Settings.", schema: None },
  "bots.create": { description: "Create a Bot. Give it a model so it can work; without one it waits until it gets one. It starts when a message first arrives for it. bots.update changes everything later.",
    schema: Type.Object({ name: Name, ...Settings }, { additionalProperties: false }) },
  "bots.update": { description: "Change a Bot's name, description, persona, model or thinking; give only what changes. Works for any Bot, yourself included. The Bot is told what changed with its next batch, in its DM with you.",
    schema: Type.Object({ bot: BotName, name: Type.Optional(Name), ...Settings }, { additionalProperties: false }) },
  "bots.start": { description: "Start a stopped Bot. A stopped Bot also starts by itself when a message arrives for it.", schema: Type.Object({ bot: BotName }, { additionalProperties: false }) },
  "bots.stop": { description: "Stop a Bot (not yourself): its current turn ends, and it stays stopped until it is started or a message arrives for it.", schema: Type.Object({ bot: BotName }, { additionalProperties: false }) },
  "bots.usage": { description: "A Bot's token use and cost over the last days (7 by default), per model.",
    schema: Type.Object({ bot: BotName, days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }, { additionalProperties: false }) },
  "bots.delete": { description: `Delete a Bot (not yourself). ${after} Its DMs and channel memberships go; its messages in channels and its workspace stay.`,
    schema: Type.Object({ bot: BotName, ...Confirm }, { additionalProperties: false }) },
  "chats.delete": { description: `Delete a channel you are in, with its threads, messages and files. ${after}`,
    schema: Type.Object({ chatId: Type.String({ description: "Channel ID" }), ...Confirm }, { additionalProperties: false }) },
  "chats.removeMembers": { description: `Remove members from a channel you are in, by name (see members.list). ${after}`,
    schema: Type.Object({ chatId: Type.String({ description: "Channel ID" }), members: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 50 }), ...Confirm }, { additionalProperties: false }) },
  "sections.delete": { description: `Delete a channel group; its channels stay, outside any group. ${after}`,
    schema: Type.Object({ section: Type.String({ minLength: 1, maxLength: 80, description: "The group's name or ID (see sections.list)" }), ...Confirm }, { additionalProperties: false }) },
};
export type AgentToolName = keyof typeof agentDefinitions;
