import { h, toast } from '../dom'
import { farmStore } from '@/data/store'
import { resetAllData, schedulePersist } from '../app'

export const settingsPage = (): HTMLElement => {
  const s = farmStore.settings!
  const nameInput = h('input', { value: s.baseName, style: { maxWidth: '280px' } })
  const probInput = h('input', { type: 'number', value: String(s.moldBaseProb), min: '0.01', max: '0.5', step: '0.01' })
  const radiusInput = h('input', { type: 'number', value: String(s.moldSpreadRadius), min: '1', max: '3', step: '1' })
  const autoInput = h('input', { type: 'checkbox', checked: s.autoTask ? true : false })

  const row = (label: string, input: HTMLElement, hint?: string) =>
    h('div', { class: 'form-row' }, h('label', {}, label), input, hint ? h('span', { class: 'muted', style: { fontSize: '12px' } }, hint) : null)

  const save = () => {
    s.baseName = nameInput.value || s.baseName
    s.moldBaseProb = Number(probInput.value)
    s.moldSpreadRadius = Number(radiusInput.value)
    s.autoTask = autoInput.checked
    if (s.autoTask) farmStore.refreshTasks()
    schedulePersist()
    toast('设置已保存')
  }

  return h(
    'div',
    { style: { maxWidth: '720px' } },
    h('div', { class: 'card' }, h('h3', { class: 'card-title' }, '基地设置'), row('基地名称', nameInput), row('绿霉基础日感染概率', probInput, '温湿度会在此基础上乘环境系数'), row('相邻感染半径（格）', radiusInput, '1 = 仅紧邻格位'), row('按状态自动派单', autoInput), h('button', { class: 'primary', onclick: save }, '保存设置')),
    h('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } }, h('h3', { class: 'card-title' }, '数据管理'), h('p', { class: 'muted', style: { fontSize: 'var(--fs-xs)' } }, `当前模拟日期：${s.simulationDay}，菌棒数据存于浏览器 IndexedDB，共 ${farmStore.total.toLocaleString()} 根 / 约 32MB 二进制记录。`), h('div', { style: { display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)' } }, h('button', {
      class: 'danger',
      onclick: async () => {
        if (window.confirm('确认重置全部档案并重新生成 40 万根测试数据？')) {
          await resetAllData()
          toast('数据已重置')
        }
      },
    }, '重置并重新生成数据'), h('button', {
      onclick: () => toast('数据全部在本地浏览器 IndexedDB，无外发'),
    }, '查看存储说明'))),
    h('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } }, h('h3', { class: 'card-title' }, '性能与技术说明'), h('ul', { class: 'muted', style: { fontSize: 'var(--fs-xs)', lineHeight: '2', paddingLeft: 'var(--sp-5)' } }, h('li', {}, '40 万根实例化绘制，视锥剔除 + 上一帧深度层级 Z 遮挡剔除，计算着色器压缩后间接绘制'), h('li', {}, '按天状态推进在计算着色器完成，双缓冲 + 两遍 dispatch，回读一次镜像到 IndexedDB'), h('li', {}, '拾取走 R32Uint ID 缓冲，id 与档案编号同源，杜绝错位'), h('li', {}, '不支持 WebGPU 的机器自动降级 Canvas2D，业务流程不受影响'))),
  )
}
