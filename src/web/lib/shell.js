// Global shell regions shared by every screen: the status line, the routed view
// host, the breadcrumb, and the two paid-spend confirmation dialogs.
// bindShell() runs once at boot.
export let statusLine;
export let view;
export let breadcrumb;
export let paidVoiceDialog;
export let confirmPaidVoice;
export let paidScriptDialog;
export let confirmPaidScript;

export function bindShell() {
  statusLine = document.querySelector("#status");
  view = document.querySelector("#view");
  breadcrumb = document.querySelector("#breadcrumb");
  paidVoiceDialog = document.querySelector("#paid-voice-dialog");
  confirmPaidVoice = document.querySelector("#confirm-paid-voice");
  paidScriptDialog = document.querySelector("#paid-script-dialog");
  confirmPaidScript = document.querySelector("#confirm-paid-script");
}

export function setStatus(message) {
  statusLine.textContent = message;
}

export function setBreadcrumb(items) {
  breadcrumb.replaceChildren(
    ...items.flatMap((item, index) => {
      const parts = [];
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = "/";
        parts.push(sep);
      }
      const node = document.createElement(item.hash ? "a" : "span");
      if (item.hash) node.href = item.hash;
      node.textContent = item.label;
      parts.push(node);
      return parts;
    }),
  );
}

// Workspace screens live under Projects in the top nav, so a review project,
// a series, or a story channel all keep the Projects link marked active.
export function setActiveNav(screen) {
  const navScreen = { "review-project": "projects", series: "projects", channel: "projects" }[screen] ?? screen;
  for (const link of document.querySelectorAll(".topnav-links [data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === navScreen);
  }
}
