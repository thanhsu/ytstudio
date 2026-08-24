import { seriesFileUrl } from "./api.js";

export function summaryGrid(items) {
  const dl = document.createElement("dl");
  dl.className = "summary-grid";
  for (const [term, description] of Object.entries(items)) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = String(description);
    dl.append(dt, dd);
  }
  return dl;
}

export function formatBytes(sizeBytes) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function checklist(items) {
  const list = document.createElement("ul");
  list.className = "checklist";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }
  return list;
}

export function wrapSection(title, ...children) {
  const section = document.createElement("section");
  section.className = "subpanel";
  section.append(sectionTitle(title), ...children);
  return section;
}

export function inlineInput(name, value) {
  const input = document.createElement("input");
  input.name = name;
  input.value = value ?? "";
  return input;
}

export function seriesLinkButton(seriesId, label, relativePath) {
  const link = document.createElement("a");
  link.className = "button-link";
  link.href = seriesFileUrl(seriesId, relativePath);
  link.target = "_blank";
  link.textContent = label;
  return link;
}

export function uploadField(label, inputId, accept, onClick) {
  const wrapper = document.createElement("div");
  wrapper.className = "upload-row";
  wrapper.append(fileField(label, inputId, accept), actionButton(label, onClick, "button", "primary"));
  return wrapper;
}

export function fileField(label, id, accept) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "file";
  input.accept = accept;
  wrapper.append(caption, input);
  return wrapper;
}

export function paragraph(text) {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

export function sectionTitle(text) {
  const element = document.createElement("h3");
  element.textContent = text;
  return element;
}

export function readinessPill(level, label) {
  const pill = document.createElement("span");
  pill.className = `status-pill status-pill-${level}`;
  pill.textContent = label;
  return pill;
}

export function gateNotice(title, text, level = "warn") {
  const notice = document.createElement("div");
  notice.className = `gate-notice gate-notice-${level}`;
  const heading = document.createElement("p");
  heading.className = "gate-notice-title";
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  notice.append(heading, body);
  return notice;
}

export function field(label, name, value, type = "text", placeholder = "", step = "1", min = "0", max) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value ?? "";
  input.placeholder = placeholder;
  if (type === "number") {
    input.min = min;
    input.step = step;
    if (max !== undefined) input.max = max;
  }
  wrapper.append(caption, input);
  return wrapper;
}

export function textareaField(label, name, value) {
  const wrapper = document.createElement("label");
  wrapper.className = "field field-wide";
  const caption = document.createElement("span");
  caption.textContent = label;
  const textarea = document.createElement("textarea");
  textarea.name = name;
  textarea.rows = 4;
  textarea.value = value ?? "";
  wrapper.append(caption, textarea);
  return wrapper;
}

export function checkboxField(label, name, checked) {
  const wrapper = document.createElement("label");
  wrapper.className = "checkbox-field";
  const input = document.createElement("input");
  input.name = name;
  input.type = "checkbox";
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}

export function selectField(label, name, value, options) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const select = document.createElement("select");
  select.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    option.selected = optionValue === value;
    select.append(option);
  }
  wrapper.append(caption, select);
  return wrapper;
}

export function actionButton(text, onClick, type = "button", variant = "") {
  const button = document.createElement("button");
  button.type = type;
  button.textContent = text;
  if (variant) button.classList.add(variant);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function formValues(form) {
  const values = {};
  for (const field of Array.from(form.elements)) {
    if (!field.name || field.type === "file") continue;
    values[field.name] = field.type === "number" ? Number(field.value) : field.value;
  }
  return values;
}

export function boolFormValues(form) {
  const values = formValues(form);
  for (const field of Array.from(form.elements)) {
    if (field.name && field.type === "checkbox") values[field.name] = field.checked;
  }
  return values;
}

export function setPathValue(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts[parts.length - 1]] = value;
}

export function lower(value) {
  return String(value ?? "").toLowerCase();
}

export function strongText(value) {
  const element = document.createElement("strong");
  element.textContent = value;
  return element;
}

export function confidenceMeter(value) {
  const wrapper = document.createElement("div");
  wrapper.className = "confidence-meter";
  const bar = document.createElement("span");
  bar.style.width = `${Math.round(value * 100)}%`;
  wrapper.append(bar, document.createTextNode(`${Math.round(value * 100)}% match`));
  return wrapper;
}

export function formatTimecode(value) {
  const total = Math.max(0, Number(value));
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const frames = Math.floor((total % 1) * 30);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export function formatSeconds(value) { return `${Number(value).toFixed(1)}s`; }

export function preBlock(text) {
  const pre = document.createElement("pre");
  pre.className = "artifact-pre";
  pre.textContent = text;
  return pre;
}

export function tableCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}
