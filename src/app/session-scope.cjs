'use strict';

const conversation = session => `${session.platform}:${session.channelId}`;
function defaultChatName(session) {
  const name = [session.username, session.event?.user?.name, session.userId]
    .find(value => typeof value === 'string' && value.trim()) || '默认会话';
  return name.trim().slice(0, 40);
}
function accessFilter(config) {
  const users = new Set(config.allowedUsers);
  return session => session.platform === 'qq' && (session.isDirect
    ? users.has('*') || users.has(session.userId)
    : config.groupChat === true && !!session.stripped?.appel);
}
module.exports = { conversation, defaultChatName, accessFilter };
