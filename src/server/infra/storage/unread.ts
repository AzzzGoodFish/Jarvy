import { HANDED_TO_BOT } from "./inbox-repository.js";

/** Unread for one member (`:member`) in the chat `chat` names, a parameter or, to count many chats in one statement,
 * a column: after its read position, not its own, and — for Bots — not already handed to it (A37: a message
 * delivered to a Bot counts as read; a person's delivered message stays unread until read). A channel copy of a
 * thread reply is not unread for the thread's followers: they have it in the thread. */
export const unreadIn = (chat: string) => `FROM messages m WHERE m.chat_id=${chat} AND m.sender_id<>:member
  AND m.sequence>COALESCE((SELECT read_sequence FROM chat_states WHERE chat_id=${chat} AND member_id=:member),0)
  AND NOT ${HANDED_TO_BOT}
  AND NOT (m.echo_of IS NOT NULL AND EXISTS(SELECT 1 FROM chat_states f WHERE f.chat_id=m.echo_of AND f.member_id=:member AND f.following=1))`;

/** The unread messages that call for the member: every one in a DM, elsewhere those that @-mention it. */
export const mentionsIn = (chat: string) => `${unreadIn(chat)} AND ((SELECT type FROM chats WHERE id=${chat})='dm'
  OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.member_id=:member))`;
