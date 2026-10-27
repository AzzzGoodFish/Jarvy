import type { ChatMessage, DeliveryMessage } from "../../shared/chat.js";
import { mentionedMembers } from "../../../contract/mentions.js";
import { echoTargets, messageTargets } from "../delivery/routes.js";
import { plan } from "../delivery/delivery.js";
import type {
  ChatParts,
  ChatInfo,
  ChatMembers,
  ChatMessages,
  ChatPersistence,
} from "./contracts.js";

/**
 * 一个 Chat 实例负责聊天内的消息保存与成员投递。
 * 管理入口创建实例并完成访问授权；各组成对象绑定同一个 Chat。
 * 本类不持有 Bot 的模型、AgentRuntime 或 Memory，也不解释 History 来源。
 */
export class Chat {
  public readonly id: string;
  public readonly info: ChatInfo;
  public readonly members: ChatMembers;
  public readonly messages: ChatMessages;

  private readonly persistence: ChatPersistence;

  public constructor(id: string, parts: ChatParts, persistence: ChatPersistence) {
    this.id = id;
    this.info = parts.info;
    this.members = parts.members;
    this.messages = parts.messages;
    this.persistence = persistence;
  }

  /** 发送者由调用方身份绑定；消息先提交，再把投递交给收件端。谁收到由路由决定（A41，`delivery/routes.ts`），
   * 多急由策略表决定；@ 解析结果随消息保存，回复算 @ 原作者。 */
  public async deliver(senderId: string, message: DeliveryMessage): Promise<ChatMessage> {
    const sender = await this.members.requireSender(senderId);
    const members = (await this.members.list()).filter(membership => membership.canRead).map(membership => membership.member);
    const dm = this.info.snapshot().type === "dm";
    const mentioned = dm ? [] : mentionedMembers(message.content, members).filter(member => member.id !== sender.id);
    const quoted = !dm && message.replyTo ? (await this.messages.read(message.replyTo))?.sender : undefined;
    const replied = quoted && quoted.id !== sender.id ? members.find(member => member.id === quoted.id) : undefined;
    const targets = messageTargets({ dm, sender, members, mentioned, replied, subscribers: dm ? [] : await this.members.subscribers() });
    const audience = message.alsoToChannel ? await this.members.channelAudience() : null;
    const muted = await this.members.muted();
    const deliveries = { message: plan("message", targets, muted),
      echo: audience ? plan("message", echoTargets({ sender, ...audience, reached: targets }), audience.muted) : [] };
    const mentions = [...mentioned, ...(replied && !mentioned.includes(replied) ? [replied] : [])].map(member => member.id);
    const saved = await this.messages.append(sender, message, deliveries, mentions);
    if (!saved.duplicate) {
      this.members.notify(saved.message, deliveries.message);
      if (saved.echo && deliveries.echo.length) this.members.notify(saved.echo, deliveries.echo);
    }
    return saved.message;
  }

  /** 管理入口确认删除权限后调用；所属数据由存储模块统一删除。 */
  public async delete(): Promise<void> {
    await this.persistence.delete(this.id);
  }

}
