import { h, toast, num } from '../dom'
import { farmStore } from '@/data/store'
import { F, STICK_FLOATS, stickCode } from '@/domain/record'
import { StickStatus } from '@/domain/types'
import { statusTag } from '../status_ui'
import { appState, navigate } from '../app'

const ageOf = (iso: string): number =>
  Math.round((new Date(farmStore.settings!.simulationDay + 'T00:00:00').getTime() - new Date(iso + 'T00:00:00').getTime()) / 86400000)

export const batchPage = (): HTMLElement => {
  const r = farmStore.records

  // 每批次聚合：跨棚集合 + 状态分布
  const agg = farmStore.batches.map((b) => {
    const houses = new Set<number>()
    const byStatus = new Array<number>(8).fill(0)
    let mold = 0
    for (let id = b.id; id < farmStore.total; id += farmStore.batches.length) {
      const o = id * STICK_FLOATS
      houses.add(r[o + F.greenhouseId])
      const st = r[o + F.status] as StickStatus
      byStatus[st]++
      if (st === StickStatus.GreenMold) mold++
    }
    return { batch: b, houses: [...houses].sort((a, c) => a - c), byStatus, mold }
  })

  const rows = agg.map(({ batch: b, houses, byStatus, mold }) =>
    h(
      'tr',
      { class: 'clickable' },
      h('td', { style: { fontWeight: 'var(--fw-medium)' } }, b.code),
      h('td', {}, b.variety),
      h('td', {}, b.inoculatedAt),
      h('td', {}, `${ageOf(b.inoculatedAt)} 天`),
      h('td', {}, num(b.baseWeightG)),
      h('td', {}, num(b.count)),
      h('td', {}, houses.map((hid) => farmStore.house(hid)?.code).join('、')),
      h('td', { style: mold ? { color: 'var(--c-danger)' } : {} }, num(mold)),
    ),
  )

  // 单棒档案查询
  const searchInput = h('input', { placeholder: '输入档案编号，如 S0020003', style: { width: '240px' } })
  const resultHost = h('div', {})
  const doSearch = () => {
    const raw = searchInput.value.trim().toUpperCase()
    const id = raw.startsWith('S') ? Number(raw.slice(1)) : Number(raw)
    if (!Number.isInteger(id) || id < 0 || id >= farmStore.total) {
      toast('编号不存在，请输入 0 - ' + (farmStore.total - 1) + ' 之间的编号')
      return
    }
    const s = farmStore.stick(id)!
    const batch = farmStore.batchOf(s.batchId)!
    const house = farmStore.house(s.greenhouseId)!
    resultHost.replaceChildren(
      h(
        'div',
        { class: 'card', style: { marginTop: 'var(--sp-4)' } },
        h('h3', { class: 'card-title' }, `菌棒档案 ${stickCode(id)}`),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '所属批次'), h('span', {}, `${batch.code}（${batch.variety}）`)),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '所在棚位'), h('span', {}, `${house.code} · 格位 ${s.slotIndex}`)),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '当前状态'), statusTag(s.status)),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '菌龄 / 状态天数'), h('span', {}, `${s.ageDays} 天 / 第 ${s.statusDay + 1} 天`)),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '棒重 / 含水率'), h('span', {}, `${s.weightG.toFixed(0)} g / ${(s.moisture * 100).toFixed(1)}%`)),
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '潮次 / 转色'), h('span', {}, `第 ${s.flushNo} 潮 · ${(s.colorProgress * 100).toFixed(0)}%`)),
        h('div', { style: { marginTop: 'var(--sp-4)' } }, h('button', { class: 'primary', onclick: () => { farmStore.select(id); appState.flyHouse = s.greenhouseId; navigate('inspect') } }, '在三维中定位')),
      ),
    )
  }
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch()
  })

  return h(
    'div',
    {},
    h('div', { class: 'card' }, h('h3', { class: 'card-title' }, '接种批次（一批可跨多棚追溯）'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '批次号'), h('th', {}, '品种'), h('th', {}, '接种日期'), h('th', {}, '菌龄'), h('th', {}, '棒重 g'), h('th', {}, '数量'), h('th', {}, '分布棚'), h('th', {}, '污染'))), h('tbody', {}, ...rows)))),
    h('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } }, h('h3', { class: 'card-title' }, '单棒档案查询'), h('div', { style: { display: 'flex', gap: 'var(--sp-3)' } }, searchInput, h('button', { class: 'primary', onclick: doSearch }, '查档案')), resultHost),
  )
}
