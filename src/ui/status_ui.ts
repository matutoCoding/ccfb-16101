import { STATUS_COLOR, STATUS_LABEL, StickStatus } from '@/domain/types'
import { h } from './dom'

const CSS_COLOR: Record<StickStatus, string> = {
  [StickStatus.SpawnRun]: '#d9d4c8',
  [StickStatus.ColorChange]: '#8a5d3a',
  [StickStatus.BudInduce]: '#946a45',
  [StickStatus.Fruiting]: '#9c7148',
  [StickStatus.Resting]: '#866547',
  [StickStatus.Watering]: '#6b5648',
  [StickStatus.GreenMold]: '#478c33',
  [StickStatus.Scrapped]: '#524d48',
}

void STATUS_COLOR

export const statusTag = (status: StickStatus): HTMLElement =>
  h(
    'span',
    { class: 'tag' },
    h('span', { class: 'dot', style: { background: CSS_COLOR[status] } }),
    STATUS_LABEL[status],
  )

export const statusDot = (status: StickStatus): HTMLElement =>
  h('span', {
    class: 'dot',
    title: STATUS_LABEL[status],
    style: { background: CSS_COLOR[status], width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block' },
  })

export const STATUS_ORDER: StickStatus[] = [
  StickStatus.SpawnRun,
  StickStatus.ColorChange,
  StickStatus.BudInduce,
  StickStatus.Fruiting,
  StickStatus.Resting,
  StickStatus.Watering,
  StickStatus.GreenMold,
  StickStatus.Scrapped,
]

export { CSS_COLOR }
