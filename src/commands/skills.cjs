'use strict';
const { splitText } = require('../lib/reply.cjs');
const { modeOf, contextOf, modeLabel } = require('../core/modes.cjs');
function registerSkills({ command, manage, chats, skills, busy, maxTextChars }) {
  command('/skill [名称:text]', '技能库；list/show 查看，名称选择，off 关闭').action(manage((owner, chat, value, defaultName) => {
    const current = chats.current(owner, chat);
    const skillMode = modeOf(current) === 'local' ? 'local' : 'work';
    const selected = contextOf(current, skillMode).skill;
    const label = `当前技能：${selected || '未启用'}（${skillMode === 'local' ? '本地文字规则' : '工作模式原生技能'}）。`;
    if (value && /[\r\n]/.test(value)) throw Error('用法：/skill [名称|list 页码|show 名称|off]');
    const parsed = /^(list|show|off)(?:[ \t]+(.*))?$/.exec(value || '');
    const action = parsed?.[1], argument = parsed?.[2]?.trim();
    if (!value || action === 'list') {
      if (argument && !/^[1-9]\d{0,3}$/.test(argument)) throw Error('用法：/skill list [页码]');
      const page = Number(argument || 1), library = skills.list();
      const heading = label + `\n/skill 名称 选择；/skill show 名称 查看；/skill off 关闭。\n`
        + (library.invalid.length ? `另有 ${library.invalid.length} 个无效技能：${library.invalid.slice(0, 3).join('、')}；show 可查看错误。\n` : '');
      const pages = splitText(library.skills.map(s => `${s.name}：${s.description.slice(0, 80)}`).join('\n') || '暂无可用技能，请在本机技能库添加 SKILL.md。',
        Math.max(16, maxTextChars - heading.length - 100));
      if (page > pages.length) throw Error(`技能列表只有 ${pages.length} 页`);
      return heading + `第 ${page}/${pages.length} 页。\n` + pages[page - 1]
        + (page < pages.length ? `\n/skill list ${page + 1} 查看下一页。` : '');
    }
    if (action === 'show') {
      let page = 1, name = argument;
      if (argument?.startsWith('--page')) {
        const paging = /^--page[ \t]+([1-9]\d{0,3})(?:[ \t]+(.+))?$/.exec(argument);
        if (!paging) throw Error('用法：/skill show --page 页码 [名称]');
        page = Number(paging[1]); name = paging[2];
      }
      name ||= selected;
      if (!name) return label + '\n/skill show 名称 查看技能。';
      const skill = skills.read(name), heading = `技能：${skill.name}，版本 ${skill.revision.slice(0, 8)}。`;
      const pages = splitText(skill.description + '\n\n' + skill.instructions, Math.max(16, maxTextChars - heading.length - 150));
      if (page > pages.length) throw Error(`技能正文只有 ${pages.length} 页`);
      return heading + `第 ${page}/${pages.length} 页。\n` + pages[page - 1]
        + (page < pages.length ? `\n/skill show --page ${page + 1} ${skill.name} 查看下一页。` : '');
    }
    if (action === 'off' && argument) throw Error('用法：/skill off');
    if (current && busy(current.id)) throw Error('当前会话正在处理任务，请等待完成或用 /stop 停止后再切换技能');
    if (action === 'off') {
      if (current) chats.setSkill(current.id, owner, chat, undefined);
      return '当前会话后续消息不再选择技能。历史内容仍保留；需要空白上下文时请 /new。';
    }
    const skill = skills.read(value.replace(/^@/, '').replace(/[ \t]+/g, '-'));
    const s = current || chats.ensure(owner, chat, defaultName);
    chats.setSkill(s.id, owner, chat, skill.name);
    return `已选择技能：${skill.name}。下一条消息起生效；/skill off 关闭。\n当前模式：${modeLabel(s)}。工作模式调用网页已安装的原生 @技能；本地模型使用本机 SKILL.md。`;
  }));
}
module.exports = { registerSkills };
