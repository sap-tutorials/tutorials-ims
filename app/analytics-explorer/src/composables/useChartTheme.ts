import * as echarts from 'echarts/core'

let installed = false
let observer: MutationObserver | null = null

function buildTheme(): any {
  const css = getComputedStyle(document.documentElement)
  const colors = Array.from({ length: 12 }, (_, i) =>
    css.getPropertyValue(`--sapChart_OrderedColor_${i + 1}`).trim() ||
    css.getPropertyValue(`--sapChartLineColor${i + 1}`).trim() ||
    `hsl(${i * 30}, 60%, 50%)`)
  return {
    color: colors,
    backgroundColor: 'transparent',
    textStyle: { color: css.getPropertyValue('--sapTextColor').trim() || '#222' },
  }
}

function currentThemeName(): 'horizon-light' | 'horizon-dark' {
  const html = document.documentElement
  const dark = html.dataset.theme === 'dark' || html.classList.contains('dark')
  return dark ? 'horizon-dark' : 'horizon-light'
}

export function installChartTheme() {
  if (installed) return
  installed = true
  echarts.registerTheme('horizon-light', buildTheme())
  echarts.registerTheme('horizon-dark', buildTheme())
  observer = new MutationObserver(() => {
    echarts.registerTheme('horizon-light', buildTheme())
    echarts.registerTheme('horizon-dark', buildTheme())
    document.querySelectorAll('[data-echarts]').forEach(el => {
      const inst = (echarts as any).getInstanceByDom(el as HTMLElement)
      if (inst) {
        const opt = inst.getOption()
        inst.dispose()
        echarts.init(el as HTMLElement, currentThemeName()).setOption(opt)
      }
    })
  })
  observer.observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'class'],
  })
}

export function getCurrentChartTheme() { return currentThemeName() }

export function disposeChartTheme() {
  if (observer) {
    observer.disconnect()
    observer = null
  }
  installed = false
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeChartTheme())
}
