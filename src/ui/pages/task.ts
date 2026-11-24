import { h, num } from '../dom'
import { farmStore } from '@/data/store'
import { TASK_LABEL } from '@/domain/tasks'
import type { TaskKind } from '@/domain/types'
import { schedulePersist, navigate, appState } from '../app'

const KIND_STYLE: Record<TaskKind, string> = {
  clean: 'var(--c-danger)',
  water: 'var(--c-primary)',
  turn: 'var(--c-warn)',
  harvest: 'var(--c-success)',
}

export const taskPage = (): HTMLElement => {
  const refresh = () => {
    farmStore.refreshTasks()
    host.replaceChildren(build())
  }

  const build = () => {
    const tasks = farmStore.tasks
    const doneCount = tasks.filter((t) => t.done).length
    const rows = tasks.map((t) =>
      h(
        'tr',
        { style: t.done ? { opacity: '0.5' } : {} },
        h('td', {}, h('span', { class: 'tag', style: { color: KIND_STYLE[t.kind], borderColor: KIND_STYLE[t.kind] } }, TASK_LABEL[t.kind])),
        h('td', { style: { fontWeight: 'var(--fw-medium)' } }, farmStore.house(t.greenhouseId)?.code ?? '-'),
        h('td', {}, t.row >= 0 ? `第 ${t.row + 1} 排${t.tier >= 0 ? ` ${t.tier + 1} 层` : ''}` : '整棚'),
        h('td', {}, num(t.stickCount)),
        h('td', {}, t.dueDate),
        h('td', { class: 'muted', style: { maxWidth: '320px' } }, t.note),
        h('td', {}, h('button', {
          onclick: () => {
            farmStore.toggleTask(t.id)
            schedulePersist()
            refresh()
          },
        }, t.done ? '撤销' : '完成')),
        h('td', {}, h('button', {
          onclick: () => {
            appState.flyHouse = t.greenhouseId
            navigate('inspect')
          },
        }, '去现场')),
      ),
    )

    return h(
      'div',
      {},
      h('div', { class: 'page-header-row' }, h('div', {}, h('div', { style: { fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-semibold)' } }, `${tasks.length} 张工单 · 已完成 ${doneCount}`), h('div', { class: 'muted', style: { marginTop: 'var(--sp-1)' } }, '按菌棒状态自动派单：补水 / 翻棒 / 采菇 / 清污染，按棚按排出单')), h('button', { class: 'primary', onclick: refresh }, '重新派单')),
      h('div', { class: 'card' }, h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '类型'), h('th', {}, '棚号'), h('th', {}, '位置'), h('th', {}, '棒数'), h('th', {}, '到期'), h('th', {}, '说明'), h('th', {}, '状态'), h('th', {}, '操作'))), h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: '8', style: { textAlign: 'center' }, class: 'muted' }, '暂无工单'))]))))),
      yieldSection(),
    )
  }

  const yieldSection = () => {
    const yields = farmStore.yields().slice(0, 8)
    return h('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } }, h('h3', { class: 'card-title' }, '潮次与产量估算（前 8 栋）'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '棚号'), h('th', {}, '潮次明细'), h('th', {}, '预估总产 kg'))), h('tbody', {}, ...yields.map((y) => h('tr', {}, h('td', { style: { fontWeight: 'var(--fw-medium)' } }, farmStore.house(y.greenhouseId)?.code), h('td', { class: 'muted' }, y.flushes.map((f) => `第${f.flushNo}潮 ${f.sticks}棒/${f.estKg}kg`).join('，')), h('td', {}, num(y.totalKg)))))))
  }

  const host = h('div', {}, build())
  return host
}
