// 超轻量 DOM 构建：h(tag, props, ...children)
export type Child = Node | string | number | null | undefined | false

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v)
    } else el.setAttribute(k, String(v))
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export const clear = (el: HTMLElement): void => {
  el.replaceChildren()
}

export const mount = (el: HTMLElement, node: Node): void => {
  el.replaceChildren(node)
}

let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined

export const toast = (msg: string, duration = 2200): void => {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast' })
    document.body.append(toastEl)
  }
  toastEl.textContent = msg
  toastEl.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0'
  }, duration)
}

// 数字千分位
export const num = (n: number): string => n.toLocaleString('zh-CN')

export const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`
