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

// AI mode changes are persisted asynchronously. The desktop UI temporarily
// restores the committed selection while IPC is pending, so check()'s immediate
// checked-state assertion is not the completion condition for this control.
export async function selectCommittedAIMode(page, mode, {timeout=10000}={}) {
  if(!['api','chatgpt-local'].includes(mode))throw new Error('Unsupported AI mode');
  await page.locator(`input[name="ai-mode"][value="${mode}"]`).click();
  await page.waitForFunction(expected=>document.body.dataset.aiMode===expected
    && document.body.dataset.aiReady==='true'
    && !document.querySelector('#ai-mode-picker').disabled
    && document.querySelector(`input[name="ai-mode"][value="${expected}"]`).checked,mode,{timeout});
  const snapshot=await page.evaluate(()=>window.desktopAPI.command('ai-get-state'));
  if(!snapshot?.ok || snapshot.ai?.mode!==mode)throw new Error(`AI mode was not committed: expected ${mode}, received ${snapshot?.ai?.mode || snapshot?.error || 'unknown'}`);
}
