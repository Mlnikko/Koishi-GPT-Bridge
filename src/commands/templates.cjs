'use strict';
const { splitText } = require('../lib/reply.cjs');
const { textMessage, safeReason } = require('../lib/feedback.cjs');
const { MAX_PROMPT_CHARS } = require('../core/image-prompts.cjs');
const { modeOf } = require('../core/modes.cjs');
const { conversation } = require('../app/session-scope.cjs');
function registerTemplates({ command, manage, chats, imagePrompts, maxTextChars, duplicateMessage, notifications, status, forward }) {
  command('/prompt [模板名:text]', '图片模板；list/show/preview 查看，create/edit/delete 管理，名称选择，off 取消').action(manage((owner, chat, value, defaultName) => {
    const current = chats.current(owner, chat);
    const label = `当前图片模板：${current?.imagePrompt || '未选择'}。`;
    const lines = (value || '').split(/\r?\n/);
    const parsed = /^(list|show|preview|create|edit|delete|off)(?:[ \t]+(.*))?$/i.exec(lines[0]);
    const action = parsed?.[1].toLowerCase(), argument = parsed?.[2]?.trim();
    if (!value || action === 'list') {
      if (lines.length > 1 || (argument && !/^[1-9]\d{0,3}$/.test(argument))) throw Error('用法：/prompt list [页码]');
      const names = imagePrompts.list(), page = Number(argument || 1), pages = Math.max(1, Math.ceil(names.length / 15));
      if (page > pages) throw Error(`模板列表只有 ${pages} 页`);
      const entries = names.slice((page - 1) * 15, page * 15).map(name => {
        try { const author = imagePrompts.readFile(name).owner; return name + (author === owner ? ' [我创建]' : author ? ' [公共]' : ' [本地模板]'); }
        catch { return name + ' [文件无效]'; }
      });
      return label + `\n图片模板：${names.length} 个，第 ${page}/${pages} 页。\n`
        + (entries.join('\n') || '暂无模板，发送 /prompt create 名称 后换行填写正文创建。')
        + (page < pages ? `\n/prompt list ${page + 1} 查看下一页。` : '')
        + '\n/prompt 模板名 选择；/prompt show 查看正文；/prompt preview 角色名 预览替换；/draw 角色名 发送到 GPT 生成图片。可追加 | 参数名=内容。'
        + '\n/prompt create/edit 名称 后换行填写完整正文；/prompt delete 名称 删除。仅创建者可修改、删除。';
    }
    if (action === 'create' || action === 'edit') {
      if (!argument || lines.length < 2 || !lines.slice(1).join('\n').trim())
        throw Error(`用法：/prompt ${action} 名称\n下一行开始填写完整模板正文（最多 ${MAX_PROMPT_CHARS} 字，须包含 {{角色名}}）`);
      const template = imagePrompts[action](argument, lines.slice(1).join('\n'), owner);
      return `已${action === 'create' ? '创建' : '更新'}公共图片模板：${template.name}。所有用户均可查看和选择，只有你能在 QQ 编辑或删除。`
        + (action === 'create' ? `\n/prompt ${template.name} 在当前会话选择。` : '\n下一次 /draw 使用更新后的内容，已入队任务保持原版本。');
    }
    if (action === 'delete') {
      if (!argument || lines.length > 1) throw Error('用法：/prompt delete 名称');
      imagePrompts.delete(argument, owner);
      return `已删除公共图片模板：${argument}。已有对话和任务保留；使用它的会话需重新选择模板或 /prompt off。`;
    }
    if (action === 'show' || action === 'preview') {
      if (lines.length > 1) throw Error(`用法：/prompt ${action} [--page 页码] ${action === 'show' ? '[模板名]' : '角色名'}`);
      let page = 1, target = argument;
      if (argument?.startsWith('--page')) {
        const paging = /^--page[ \t]+([1-9]\d{0,3})(?:[ \t]+(.+))?$/.exec(argument);
        if (!paging) throw Error(`用法：/prompt ${action} [--page 页码] ${action === 'show' ? '[模板名]' : '角色名'}`);
        page = Number(paging[1]); target = paging[2];
      }
      const name = action === 'show' ? target || current?.imagePrompt : current?.imagePrompt;
      if (!name) throw Error('请先用 /prompt 模板名 选择图片模板');
      const snapshot = action === 'show' ? imagePrompts.read(name) : imagePrompts.render(name, target);
      const body = action === 'show' ? snapshot.template : snapshot.text;
      const heading = `${action === 'show' ? '图片模板' : '发送内容预览'}：${name}，${body.length} 字。`
        + (action === 'show' ? (snapshot.owner === owner ? ' [我创建]' : snapshot.owner ? ' [仅创建者可管理]' : ' [本地模板]') : '');
      const nextArgument = action === 'show' ? name : snapshot.request;
      const navigation = `/prompt ${action} --page 9999 ${nextArgument}`;
      const pages = splitText(body, Math.max(16, maxTextChars - heading.length - navigation.length - 100));
      if (page > pages.length) throw Error(`正文只有 ${pages.length} 页`);
      return heading + `\n第 ${page}/${pages.length} 页。\n` + pages[page - 1]
        + (page < pages.length ? `\n/prompt ${action} --page ${page + 1} ${nextArgument} 查看下一页。` : '')
        + (action === 'preview' ? '\n尚未发送；/draw 后填写相同角色名和参数，使用发送时的最新模板生成图片。' : '');
    }
    if (action === 'off') {
      if (argument || lines.length > 1) throw Error('用法：/prompt off');
      if (current) chats.setImagePrompt(current.id, owner, chat, undefined);
      return '已取消当前图片模板选择。已提交任务和聊天历史保留。';
    }
    const template = imagePrompts.read(value);
    const s = current || chats.ensure(owner, chat, defaultName);
    chats.setImagePrompt(s.id, owner, chat, template.name);
    const required = template.fields.filter(f => f.name !== '角色名' && f.name !== '补充要求' && f.fallback === undefined).map(f => f.name);
    const optional = [...new Set([...template.fields.filter(f => f.name !== '角色名' && f.fallback !== undefined).map(f => f.name), '补充要求'])];
    return `已选择图片模板：${template.name}。\n/draw 角色名 发送到 GPT；/prompt preview 角色名 仅预览。`
      + (required.length ? `\n必填参数：${required.join('、')}。` : '')
      + `\n可选参数：${optional.join('、')}。\n追加参数：角色名 | 参数名=内容。/prompt show 查看默认值和适配规则。普通消息仍正常聊天。`;
  }));
  command('/draw [角色名:text]', '图片模板生图：角色名，可追加 | 参数名=内容').action(async ({ session }, request) => {
    try {
      const duplicate = duplicateMessage(session);
      if (duplicate) return notifications(session) ? textMessage(status(duplicate)) : undefined;
      const chat = chats.current(session.userId, conversation(session));
      if (!chat?.imagePrompt) return '请先用 /prompt 查看列表，再用 /prompt 模板名 选择图片模板。';
      if (modeOf(chat) === 'local') return '图片模板通过 ChatGPT 网页生成图片，请先发送 /mode 工作，再用 /draw 角色名。';
      return await forward(session, imagePrompts.render(chat.imagePrompt, request));
    } catch (err) { return textMessage(safeReason(err.message)); }
  });
}
module.exports = { registerTemplates };
