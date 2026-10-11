import type { Delivery } from "../../shared/delivery.js";
import type {
  ChatMessage,
  MemberIdentity,
  DeliveryMessage,
} from "../../shared/chat.js";

/** Chat 使用组成对象的契约；不包含 API、Bot Runtime 或数据库实现。 */
export interface ChatParts {
  info: ChatInfo;
  members: ChatMembers;
  messages: ChatMessages;
}

export interface ChatInfo {
  snapshot(): ChatInfoSnapshot;
  update(input: { title: string }): Promise<void>;
}

export interface ChatInfoSnapshot {
  title: string;
  type: "dm" | "channel" | "thread";
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMembership {
  member: MemberIdentity;
  canRead: boolean;
  canWrite: boolean;
}

export interface ChatMembers {
  list(): Promise<readonly ChatMembership[]>;
  get(memberId: string): Promise<ChatMembership | null>;
  add(membership: ChatMembership): Promise<void>;
  remove(memberId: string): Promise<void>;

  /** 确认发送者是允许发言的成员，返回由成员模块取得的身份。 */
  requireSender(senderId: string): Promise<MemberIdentity>;

  /** 订阅了本频道/线程的成员 ID。 */
  subscribers(): Promise<readonly string[]>;
  /** 对本会话（线程也看所属频道）开了免打扰的成员。 */
  muted(): Promise<readonly string[]>;
  /** 线程所属频道里能读的成员和订阅者，用于「同时发到频道」的副本；不是线程时为 null。 */
  channelAudience(): Promise<{ members: readonly MemberIdentity[]; subscribers: readonly string[]; muted: readonly string[] } | null>;

  /** 只把已提交的投递交给收件端（A41），不等待成员完成模型执行。 */
  notify(message: ChatMessage, deliveries: readonly Delivery[]): void;
}

export interface ChatMessages {
  /**
   * 保存完整消息、附件、接收成员的投递项及聊天更新时间。
   * 这些存储变化在同一事务中提交；source 原样保存，不在 Chat 中推测。
   */
  append(
    sender: MemberIdentity,
    message: DeliveryMessage,
    deliveries: AppendDeliveries,
    mentions?: readonly string[],
  ): Promise<AppendResult>;

  read(messageId: string): Promise<ChatMessage | null>;
  list(options: { after?: number; limit: number }): Promise<readonly ChatMessage[]>;
  search(query: string, options: { limit: number }): Promise<readonly ChatMessage[]>;
}

/** 路由算好的投递（A41）：消息本身的，和「同时发到频道」副本的。存储照单写，不再判断谁该收。 */
export interface AppendDeliveries { message: readonly Delivery[]; echo: readonly Delivery[] }
export interface AppendResult {
  message: ChatMessage;
  /** 相同发送意图已保存时返回原记录，不再次投递。 */
  duplicate: boolean;
  /** 「同时发到频道」的副本。 */
  echo?: ChatMessage;
}

export interface ChatPersistence {
  /**
   * 一次删除聊天记录及其成员关系、消息、附件和待投递项。
   * 不删除成员本身，也不删除 Bot 自己的 Memory/History。
   */
  delete(chatId: string): Promise<void>;
}
