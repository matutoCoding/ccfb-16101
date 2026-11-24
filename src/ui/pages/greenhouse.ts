import { h, toast, num } from '../dom'
import { farmStore } from '@/data/store'
import { slotCapacity } from '@/domain/layout'
import { schedulePersist } from '../app'
import { STATUS_LABEL, StickStatus, type Greenhouse } from '@/domain/types'

let selectedHouse = 0

const numberInput = (value: number, min: number, max: number, onchange: (v: number) => void) =>
  h('input', {
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value)
      if (v >= min && v <= max) onchange(v)
      else toast(`取值需在 ${min}-${max} 之间`)
    },
  })

const detailPanel = (house: Greenhouse): HTMLElement => {
  const stats = farmStore.stats().find((s) => s.greenhouseId === house.id)
  const l = house.layout
  const currentCap = slotCapacity(l)

  const editState = { ...l }
  const capPreview = h('span', {}, String(slotCapacity(editState)))
  const refreshCap = () => {
    capPreview.textContent = String(slotCapacity(editState))
  }

  const save = () => {
    const newCap = slotCapacity(editState)
    const occupied = stats?.total ?? 0
    if (newCap < occupied) {
      toast(`容量 ${newCap} 小于在架 ${occupied} 根，无法重排`)
      return
    }
    const ok = farmStore.relayout(house.id, { ...editState })
    if (ok) {
      toast(`已重排：${house.code} 新容量 ${newCap} 格，菌棒按统一映射重新上架，无重格`)
      schedulePersist()
    }
  }

  const formRow = (label: string, input: HTMLElement) => h('div', { class: 'form-row' }, h('label', {}, label), input)

  return h(
    'div',
    { class: 'card' },
    h('h3', { class: 'card-title' }, `${house.code} 档案`),
    h('div', { class: 'section-label' }, '基础参数'),
    formRow('棚长（米）', h('input', { value: String(house.layout.lengthM), disabled: true })),
    formRow('棚宽（米）', h('input', { value: String(house.layout.widthM), disabled: true })),
    formRow('层架排数', numberInput(editState.shelfRows, 2, 16, (v) => { editState.shelfRows = v; refreshCap() })),
    formRow('层数', numberInput(editState.tiers, 2, 8, (v) => { editState.tiers = v; refreshCap() })),
    formRow('每排列数', numberInput(editState.cols, 50, 600, (v) => { editState.cols = v; refreshCap() })),
    formRow('通道宽（米）', numberInput(editState.aisleM, 0.6, 1.4, (v) => { editState.aisleM = v })),
    h('div', { class: 'form-row' }, h('label', {}, '格位容量'), h('div', { style: { display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' } }, capPreview, h('span', { class: 'muted' }, `当前在架 ${num(stats?.total ?? 0)} 根`))),
    h('div', { style: { display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)' } }, h('button', { class: 'primary', onclick: save }, '保存并重排')),

    h('div', { class: 'section-label', style: { marginTop: 'var(--sp-6)' } }, '温湿度（驱动绿霉概率）'),
    formRow('温度 °C', numberInput(Math.round(house.tempC * 10) / 10, 5, 38, (v) => { house.tempC = v; farmStore.setHouseEnv(house.id, v, house.humidity); schedulePersist() })),
    formRow('湿度 %', numberInput(Math.round(house.humidity * 100), 30, 99, (v) => { house.humidity = v / 100; farmStore.setHouseEnv(house.id, house.tempC, v / 100); schedulePersist() })),

    h('div', { class: 'section-label', style: { marginTop: 'var(--sp-6)' } }, '状态构成'),
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-2)' } },
      ...stats!.byStatus.map((count, s) =>
        h('div', { class: 'detail-line' }, h('span', { class: 'k' }, STATUS_LABEL[s as StickStatus]), h('span', {}, num(count))),
      ),
    ),
  )
}

export const greenhousePage = (): HTMLElement => {
  const list = farmStore.greenhouses.map((house) => {
    const st = farmStore.stats().find((s) => s.greenhouseId === house.id)!
    return h(
      'tr',
      {
        class: `clickable${house.id === selectedHouse ? ' selected-row' : ''}`,
        onclick: () => {
          selectedHouse = house.id
          host.replaceChildren(build())
        },
      },
      h('td', { style: { fontWeight: 'var(--fw-medium)' } }, house.code),
      h('td', {}, `${house.layout.shelfRows}×${house.layout.tiers}×${house.layout.cols}`),
      h('td', {}, num(slotCapacity(house.layout))),
      h('td', {}, num(st.total)),
      h('td', { style: st.mold > 0 ? { color: 'var(--c-danger)', fontWeight: 'var(--fw-medium)' } : {} }, num(st.mold)),
      h('td', {}, `${house.tempC.toFixed(1)}°C`),
      h('td', {}, `${Math.round(house.humidity * 100)}%`),
    )
  })

  const build = () =>
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'minmax(420px, 1fr) minmax(360px, 480px)', gap: 'var(--sp-5)', alignItems: 'start' } },
      h('div', { class: 'card' }, h('h3', { class: 'card-title' }, '大棚列表（40 栋）'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '棚号'), h('th', {}, '排×层×列'), h('th', {}, '容量'), h('th', {}, '在架'), h('th', {}, '绿霉'), h('th', {}, '温度'), h('th', {}, '湿度'))), h('tbody', {}, ...list)))),
      detailPanel(farmStore.house(selectedHouse)!),
    )

  const host = h('div', {}, build())
  return host
}
