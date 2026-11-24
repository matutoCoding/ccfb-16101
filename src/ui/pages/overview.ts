import { h, num, pct } from '../dom'
import { farmStore } from '@/data/store'
import { STATUS_LABEL, StickStatus } from '@/domain/types'
import { STATUS_ORDER, statusDot } from '../status_ui'
import { appState, navigate } from '../app'
import { TASK_LABEL } from '@/domain/tasks'

const heatColor = (pending: number, mold: number): string => {
  if (mold > 200) return '#7f1d1d'
  if (mold > 50) return '#c2410c'
  if (pending > 120) return '#0f6b68'
  if (pending > 40) return '#5aa6a3'
  return '#c7dedc'
}

export const overviewPage = (): HTMLElement => {
  const stats = farmStore.stats()
  const byStatus = farmStore.globalByStatus()
  const total = farmStore.total
  const moldTotal = byStatus[StickStatus.GreenMold]
  const pendingTotal = farmStore.tasks.filter((t) => !t.done).reduce((s, t) => s + t.stickCount, 0)
  const yields = farmStore.yields()
  const totalKg = yields.reduce((s, y) => s + y.totalKg, 0)

  const kpiCard = (label: string, value: string, sub?: string, danger = false) =>
    h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value', style: danger ? { color: 'var(--c-danger)' } : {} }, value), sub ? h('div', { class: 'delta muted' }, sub) : null)

  const legend = h(
    'div',
    { class: 'legend' },
    ...STATUS_ORDER.map((s) => h('span', {}, statusDot(s), STATUS_LABEL[s], ` ${num(byStatus[s])}`)),
  )

  const cards = stats.map((st) => {
    const house = farmStore.house(st.greenhouseId)!
    const mold = st.mold
    const pending = farmStore.tasks.filter((t) => t.greenhouseId === house.id && !t.done).length
    const moldRatio = st.total ? mold / st.total : 0
    return h(
      'div',
      {
        class: 'house-card',
        onclick: () => {
          appState.flyHouse = house.id
          appState.page = 'inspect'
          navigate('inspect')
        },
      },
      h('div', { class: 'hc-head' }, h('span', { class: 'hc-code' }, house.code), mold > 0 ? h('span', { class: 'tag', style: { color: 'var(--c-danger)', borderColor: 'var(--c-danger)' } }, `绿霉 ${num(mold)}`) : h('span', { class: 'tag muted' }, '健康')),
      h('div', { class: 'muted', style: { fontSize: 'var(--fs-xs)' } }, `${num(st.total)} 根 · ${house.layout.shelfRows}排${house.layout.tiers}层`),
      h('div', { class: 'muted', style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--sp-2)' } }, `待办工单 ${pending} 张`),
      h('div', { class: 'heatbar' }, h('span', { style: { width: pct(Math.min(1, moldRatio * 4 + pending / 120)), background: heatColor(pending, mold) } })),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: 'var(--sp-2)' } }, `温 ${house.tempC.toFixed(1)}°C 湿 ${pct(house.humidity, 0)}`),
    )
  })

  const urgentTasks = farmStore.tasks
    .filter((t) => !t.done)
    .slice(0, 6)
    .map((t) =>
      h('tr', { class: 'clickable', onclick: () => navigate('task') }, h('td', {}, h('span', { class: 'tag', style: t.kind === 'clean' ? { color: 'var(--c-danger)' } : {} }, TASK_LABEL[t.kind])), h('td', {}, farmStore.house(t.greenhouseId)?.code ?? '-'), h('td', {}, t.row >= 0 ? `第 ${t.row + 1} 排` : '整棚'), h('td', {}, num(t.stickCount))),
    )

  return h(
    'div',
    {},
    h('div', { class: 'grid cols-4' }, kpiCard('在档菌棒', num(total), '40 个大棚 · 16 个接种批次'), kpiCard('绿霉污染', num(moldTotal), `感染率 ${pct(moldTotal / total, 2)}`, true), kpiCard('今日待办', num(pendingTotal), `${farmStore.tasks.filter((t) => !t.done).length} 张工单`), kpiCard('预估产量', `${num(Math.round(totalKg))} kg`, '按潮次模型估算')),
    h('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } }, h('h3', { class: 'card-title' }, '全基地状态分布'), legend),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 380px', gap: 'var(--sp-5)', marginTop: 'var(--sp-5)', alignItems: 'start' } }, h('div', { class: 'card' }, h('h3', { class: 'card-title' }, '大棚热力（颜色越深待办/污染越重，点击进三维巡检）'), h('div', { class: 'house-grid' }, ...cards)), h('div', { class: 'card' }, h('h3', { class: 'card-title' }, '紧急工单'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '类型'), h('th', {}, '棚号'), h('th', {}, '位置'), h('th', {}, '数量'))), h('tbody', {}, ...(urgentTasks.length ? urgentTasks : [h('tr', {}, h('td', { colspan: '4', class: 'muted', style: { textAlign: 'center' } }, '暂无待办'))]))))),
  )
}
