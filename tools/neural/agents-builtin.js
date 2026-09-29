'use strict';
/* 内置 AI 对手包装：直接用 HTML 的 aiChooseMove(difficulty) */
function builtinAgent(diff, opts){
  const label = opts && opts.label ? opts.label : ('内置' + diff);
  return {
    name: label,
    async choose(G, me, opp){
      G.state.diff = diff;
      const d = await G.aiChooseMove();
      return d;
    }
  };
}

module.exports = { builtinAgent };