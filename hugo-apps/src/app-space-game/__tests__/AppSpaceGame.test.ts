// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// -- Shared mock data --------------------------------------------------------

const MOCK_DATA = {
  eventId: 1,
  eventName: 'Test',
  type: 'DEVTOBERFEST',
  appSpaceGameEnabled: true,
  paths: [
    {
      id: 'track-alpha',
      title: 'Alpha Track',
      description: 'desc',
      items: [],
      segments: [
        {
          order: 0,
          kind: 'linear' as const,
          items: [
            {
              imsId: 1,
              title: 'Tutorial 1',
              type: 'TUTORIAL' as const,
              status: 'OPEN',
              progress: 0,
              experience: '',
              timeToComplete: 5,
              url: '/tutorials/test',
              description: 'desc',
            },
          ],
        },
      ],
    },
  ],
}

// -- Game handle factory -----------------------------------------------------

function makeGameHandle() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    setPlayerControl: vi.fn(),
    dispose: vi.fn(),
    onRingCount: vi.fn(),
    onEvent: vi.fn(),
  }
}

// -- Module mocks (hoisted so vi.mock applies before imports) ----------------

vi.mock('../feature', () => ({
  isWebGLAvailable: vi.fn(),
  loadAppSpaceData: vi.fn(),
  isGameDisabled: vi.fn(),
}))

vi.mock('../renderer', () => ({
  createGame: vi.fn(),
}))

// -- Helpers -----------------------------------------------------------------

async function mountWithGatePass() {
  const { isWebGLAvailable, loadAppSpaceData, isGameDisabled } = await import('../feature')
  const { createGame } = await import('../renderer')
  const gameHandle = makeGameHandle()

  vi.mocked(isWebGLAvailable).mockReturnValue(true)
  vi.mocked(loadAppSpaceData).mockResolvedValue(MOCK_DATA)
  vi.mocked(isGameDisabled).mockReturnValue(false)
  vi.mocked(createGame).mockReturnValue(gameHandle)

  const AppSpaceGame = (await import('../AppSpaceGame.vue')).default
  const wrapper = mount(AppSpaceGame)
  // Flush all promises to complete the async onMounted gate check
  await flushPromises()

  return { wrapper, gameHandle, createGame: vi.mocked(createGame) }
}

async function mountWithGateFail() {
  const { isWebGLAvailable, loadAppSpaceData, isGameDisabled } = await import('../feature')
  const { createGame } = await import('../renderer')

  vi.mocked(isWebGLAvailable).mockReturnValue(false)
  vi.mocked(loadAppSpaceData).mockResolvedValue(null)
  vi.mocked(isGameDisabled).mockReturnValue(false)
  vi.mocked(createGame).mockReset()

  const AppSpaceGame = (await import('../AppSpaceGame.vue')).default
  const wrapper = mount(AppSpaceGame)
  await flushPromises()

  return { wrapper, createGame: vi.mocked(createGame) }
}

async function mountWithFlagOff() {
  const { isWebGLAvailable, loadAppSpaceData, isGameDisabled } = await import('../feature')
  const { createGame } = await import('../renderer')

  vi.mocked(isWebGLAvailable).mockReturnValue(true)
  vi.mocked(loadAppSpaceData).mockResolvedValue({ ...MOCK_DATA, appSpaceGameEnabled: false })
  vi.mocked(isGameDisabled).mockReturnValue(false)
  vi.mocked(createGame).mockReset()

  const AppSpaceGame = (await import('../AppSpaceGame.vue')).default
  const wrapper = mount(AppSpaceGame)
  await flushPromises()

  return { wrapper, createGame: vi.mocked(createGame) }
}

// -- Test suites -------------------------------------------------------------

describe('AppSpaceGame attract state machine', () => {
  beforeEach(() => {
    // Fake only macrotask timers (setTimeout/clearTimeout) so the idle SM is
    // controllable. Exclude setImmediate so that flushPromises() (which
    // internally uses setImmediate) continues to drain microtasks normally.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    vi.resetAllMocks()
    // Default matchMedia: no reduced motion preference
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // (a) Idle timer fires after 60000ms -> overlay visible + game.start() called
  it('(a) shows overlay and calls game.start() after idle timeout', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    // Verify gate passed (Demo button present)
    expect(wrapper.find('[data-demo-trigger]').exists()).toBe(true)

    // Before timeout: overlay should not be visible
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)

    // Advance timers past the idle timeout
    await vi.advanceTimersByTimeAsync(60000)

    // Overlay should now be visible
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)
    // game.start() should have been called
    expect(gameHandle.start).toHaveBeenCalled()
  })

  // (b) Input event while attract is showing -> setPlayerControl(true), overlay still up
  it('(b) input event while attract is showing hands control but keeps overlay', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    // Trigger idle timeout to show attract mode
    await vi.advanceTimersByTimeAsync(60000)

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)

    // Simulate a mousemove event while attract is showing
    window.dispatchEvent(new MouseEvent('mousemove'))
    await flushPromises()

    // setPlayerControl(true) should have been called
    expect(gameHandle.setPlayerControl).toHaveBeenCalledWith(true)
    // Overlay stays up (still visible)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)
  })

  // (c) "Demo" button is present; clicking it starts the game immediately
  it('(c) Demo button is present and clicking it starts the game immediately', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    const demoBtn = wrapper.find('[data-demo-trigger]')
    expect(demoBtn.exists()).toBe(true)

    // Click Demo button - should start attract mode without waiting for timer
    await demoBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)
    expect(gameHandle.start).toHaveBeenCalled()
  })

  // (d) onPickTrack navigates via replaceState (NOT pushState) + dispatches popstate + hides overlay
  it('(d) onPickTrack uses replaceState, dispatches popstate, and hides overlay', async () => {
    const { wrapper, createGame } = await mountWithGatePass()

    // Spy on history methods
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState')
    const pushStateSpy = vi.spyOn(window.history, 'pushState')
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')

    // Trigger attract to get overlay visible first
    await vi.advanceTimersByTimeAsync(60000)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)

    // Extract onPickTrack from the createGame call args
    expect(createGame).toHaveBeenCalled()
    const callArgs = createGame.mock.calls[0]
    const opts = callArgs[2] as { onPickTrack: (id: string) => void }
    const onPickTrack = opts.onPickTrack

    // Invoke onPickTrack with a track id
    onPickTrack('track-alpha')
    await flushPromises()

    // replaceState should have been called (NOT pushState)
    expect(replaceStateSpy).toHaveBeenCalled()
    expect(pushStateSpy).not.toHaveBeenCalled()

    // The URL passed to replaceState should contain track=track-alpha
    const replaceCall = replaceStateSpy.mock.calls[0]
    const urlArg = replaceCall[2] as string
    expect(urlArg).toContain('track=track-alpha')

    // popstate event should have been dispatched
    const popstateDispatched = dispatchEventSpy.mock.calls.some(
      ([evt]) => evt instanceof PopStateEvent && evt.type === 'popstate'
    )
    expect(popstateDispatched).toBe(true)

    // Overlay should be hidden after handoff
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
  })

  // (e) Gate fails -> no overlay, no Demo button, no timer, createGame never called
  it('(e) gate failure: no overlay, no Demo button, createGame never called', async () => {
    const { wrapper, createGame } = await mountWithGateFail()

    // No overlay
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    // No demo button
    expect(wrapper.find('[data-demo-trigger]').exists()).toBe(false)
    // createGame never called
    expect(createGame).not.toHaveBeenCalled()

    // Advance timers - nothing should happen
    await vi.advanceTimersByTimeAsync(120000)
    await flushPromises()

    // Still no overlay
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    expect(createGame).not.toHaveBeenCalled()
  })

  // (f) Server flag OFF (appSpaceGameEnabled: false) -> gate does not pass
  it('(f) server flag OFF: no overlay, no Demo button, createGame never called', async () => {
    const { wrapper, createGame } = await mountWithFlagOff()

    // No overlay
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    // No demo button
    expect(wrapper.find('[data-demo-trigger]').exists()).toBe(false)
    // createGame never called
    expect(createGame).not.toHaveBeenCalled()

    // Advance timers - nothing should happen
    await vi.advanceTimersByTimeAsync(120000)
    await flushPromises()

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    expect(createGame).not.toHaveBeenCalled()
  })

  // (g) Close button is visible when overlay is showing; clicking it hides overlay
  it('(g) close button hides overlay without picking a track', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    // Trigger attract mode
    await vi.advanceTimersByTimeAsync(60000)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)

    const closeBtn = wrapper.find('[data-game-close]')
    expect(closeBtn.exists()).toBe(true)

    await closeBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    expect(gameHandle.stop).toHaveBeenCalled()
  })

  // (h) Escape key closes the overlay
  it('(h) Escape key closes the game overlay', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    // Trigger attract mode
    await vi.advanceTimersByTimeAsync(60000)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)

    // Dispatch Escape keydown on window
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    expect(gameHandle.stop).toHaveBeenCalled()
  })

  // (i) onRingCount callback updates the ring-count HUD
  it('(i) ring HUD shows count when onRingCount fires', async () => {
    const { wrapper, gameHandle } = await mountWithGatePass()

    // Trigger attract mode so the overlay (and HUD) is visible
    await vi.advanceTimersByTimeAsync(60000)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)

    // Capture the onRingCount callback registered on the game handle
    // It is set up during onMounted after createGame is called
    const onRingCountCb = gameHandle.onRingCount.mock.calls[0]?.[0] as ((n: number) => void) | undefined
    expect(typeof onRingCountCb).toBe('function')

    // Fire the callback with a count of 3
    onRingCountCb!(3)
    await flushPromises()

    // The HUD div should be in the DOM showing the count
    const hud = wrapper.find('.asg-rings')
    expect(hud.exists()).toBe(true)
    expect(hud.text()).toContain('3')
  })

  // (j) Mute toggle control is present in the mounted DOM
  it('(j) mute toggle control is present in the mounted DOM', async () => {
    const { wrapper } = await mountWithGatePass()

    // Show the overlay so the mute toggle is visible
    await vi.advanceTimersByTimeAsync(60000)

    const muteBtn = wrapper.find('[data-mute-toggle]')
    expect(muteBtn.exists()).toBe(true)
  })

  // prefers-reduced-motion: idle auto-start disabled, Demo button still works
  it('prefers-reduced-motion: idle timer does NOT auto-start, Demo button still works', async () => {
    // Override matchMedia to report reduced motion preference
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    const { wrapper, gameHandle } = await mountWithGatePass()

    // Gate should pass - Demo button present
    expect(wrapper.find('[data-demo-trigger]').exists()).toBe(true)

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(60000)

    // Overlay must NOT have appeared (reduced motion blocks idle auto-start)
    expect(wrapper.find('[data-game-overlay]').exists()).toBe(false)
    expect(gameHandle.start).not.toHaveBeenCalled()

    // Demo button should still work
    const demoBtn = wrapper.find('[data-demo-trigger]')
    await demoBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-game-overlay]').exists()).toBe(true)
    expect(gameHandle.start).toHaveBeenCalled()
  })
})
