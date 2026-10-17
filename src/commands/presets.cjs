'use strict';
const { splitText } = require('../lib/reply.cjs');
const { modeOf, contextOf } = require('../core/modes.cjs');
function registerPresets({ command, manage, chats, presets, busy, maxTextChars }) {
  command('/preset [名称:text]', '公共预设；show/list 查看，create/edit/delete 管理，off 关闭').action(manage((owner, chat, value, defaultName) => {
    const current = chats.current(owner, chat);
    const label = `当前本地预设：${contextOf(current, 'local').preset || '未启用'}。`;
    const lines = (value || '').split(/\r?\n/);
    const parsed = /^(list|show|create|edit|delete|off)(?:[ \t]+(.*))?$/i.exec(lines[0]);
    const action = parsed?.[1].toLowerCase(), argument = parsed?.[2]?.trim();
    if (!value || action === 'list') {
      if (lines.length > 1 || (argument && !/^[1-9]\d{0,3}$/.test(argument))) throw Error('用法：/preset list [页码]');
      const page = Number(argument || 1);
      const names = presets.list();
      const pages = Math.max(1, Math.ceil(names.length / 15));
      if (page > pages) throw Error(`公共预设列表只有 ${pages} 页`);
      const entries = names.slice((page - 1) * 15, page * 15).map(name => {
        try { const author = presets.readFile(name).owner; return name + (author === owner ? ' [我创建]' : author ? ' [公共]' : ' [本地模板]'); }
        catch { return name + ' [文件无效]'; }
      });
      return label + `\n公共预设：${names.length} 个，第 ${page}/${pages} 页。\n`
        + (entries.join('\n') || '暂无预设，发送 /preset create 名称 后换行填写正文创建。')
        + (page < pages ? `\n/preset list ${page + 1} 查看下一页。` : '')
        + '\n/preset 名称 选择；show 名称 查看；create/edit 名称 后换行填写正文；delete 名称 删除。仅创建者可修改、删除。';
    }
    if (action === 'create' || action === 'edit') {
      if (!argument || lines.length < 2 || !lines.slice(1).join('\n').trim())
        throw Error(`用法：/preset ${action} 名称\n下一行开始填写完整预设正文（最多 8000 字）`);
      const preset = presets[action](argument, lines.slice(1).join('\n'), owner);
      return `已${action === 'create' ? '创建' : '更新'}公共预设：${preset.name}。所有用户均可查看和选择，只有你能在 QQ 编辑或删除。`
        + (action === 'create' ? `\n/preset ${preset.name} 在当前会话选择。` : '\n下一条消息使用更新后的内容，已入队任务保持原版本。');
    }
    if (action === 'delete') {
      if (!argument || lines.length > 1) throw Error('用法：/preset delete 名称');
      presets.delete(argument, owner);
      return `已删除公共预设：${argument}。已有对话和任务保留；使用它的会话需重新选择预设或 /preset off。`;
    }
    if (action === 'show') {
      if (lines.length > 1) throw Error('用法：/preset show [名称]，翻页用 /preset show --page 页码 [名称]');
      let page = 1, name = argument;
      if (argument?.startsWith('--page')) {
        const paging = /^--page[ \t]+([1-9]\d{0,3})(?:[ \t]+(.+))?$/.exec(argument);
        if (!paging) throw Error('用法：/preset show --page 页码 [名称]');
        page = Number(paging[1]); name = paging[2];
      }
      name ||= contextOf(current, 'local').preset;
      if (!name) return label + '\n/preset show 名称 可查看任意公共预设。';
      const preset = presets.read(name);
      const heading = (contextOf(current, 'local').preset === preset.name ? label + '\n' : '')
        + `公共预设：${preset.name}。`
        + (preset.owner === owner ? ' [我创建]' : preset.owner ? ' [仅创建者可管理]' : ' [本地模板]');
      const navigation = `\n（预览已分页；/preset show --page 9999 ${preset.name} 查看下一页。）`;
      const content = splitText(preset.prompt, Math.max(16, maxTextChars - heading.length - navigation.length - 80));
      if (page > content.length) throw Error(`预设正文只有 ${content.length} 页`);
      return heading
        + `\n${preset.prompt.length} 字，版本 ${preset.revision.slice(0, 8)}，第 ${page}/${content.length} 页。\n`
        + content[page - 1]
        + (page < content.length ? `\n（预览已分页；/preset show --page ${page + 1} ${preset.name} 查看下一页。）` : '');
    }
    if (action === 'off' && (argument || lines.length > 1)) throw Error('用法：/preset off');
    if (current && busy(current.id)) throw Error('当前会话正在处理任务，请等待完成或用 /stop 停止后再切换预设');
    if (action === 'off') {
      if (current) chats.setPreset(current.id, owner, chat, undefined);
      return '当前会话已关闭本地预设。已有聊天记录保留，/new 开启空白上下文。';
    }
    const preset = presets.read(value);
    const s = current || chats.ensure(owner, chat, defaultName);
    chats.setPreset(s.id, owner, chat, preset.name);
    return `会话「${s.name}」已选择本地预设：${preset.name}。下一条本地模型消息起生效。`
      + (modeOf(s) === 'local' ? '' : '\n/mode 本地 切换到本地模型后使用。')
      + '\n已有聊天记录保留，/new 沿用预设开启新剧情。';
  }));
}
module.exports = { registerPresets };
