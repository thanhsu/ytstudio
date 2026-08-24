// Global shell regions shared by every screen: the status line and the two
// paid-spend confirmation dialogs. bindShell() runs once at boot.
export let statusLine;
export let paidVoiceDialog;
export let confirmPaidVoice;
export let paidScriptDialog;
export let confirmPaidScript;

export function bindShell() {
  statusLine = document.querySelector("#status");
  paidVoiceDialog = document.querySelector("#paid-voice-dialog");
  confirmPaidVoice = document.querySelector("#confirm-paid-voice");
  paidScriptDialog = document.querySelector("#paid-script-dialog");
  confirmPaidScript = document.querySelector("#confirm-paid-script");
}

export function setStatus(message) {
  statusLine.textContent = message;
}
