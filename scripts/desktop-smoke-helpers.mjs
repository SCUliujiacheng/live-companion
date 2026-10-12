// Shared with the browser regression test so native smoke readiness cannot
// accidentally accept hidden text retained from a previous session.
export async function waitForPendingCandidate(page, {mode, timeout=22000}={}) {
  await page.waitForFunction(expectedMode=>{
    const content=document.querySelector('#candidate-content');
    return content && !content.hidden
      && document.querySelector('#candidate-text').textContent.trim().length>0
      && document.querySelector('#status-label').textContent==='陪聊中'
      && (!expectedMode || document.querySelector('input[name="mode"]:checked')?.value===expectedMode);
  },mode,{timeout});
}
