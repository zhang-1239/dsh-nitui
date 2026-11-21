/**
 * Browser half of the nitui bundle (逆推).
 *
 * Seats:
 *   conversation.input.dock      「压一下」按钮（输入框左上角）+ 三问卡片 / 验尸卡
 *   conversation.composer.dock   暗线召回的三行旧账
 *   sidebar.panellist + main     我的推演
 *   settings.section             暗线设置与「我记录了什么」
 *
 * The browser keeps only the card that is currently open; every record comes
 * from the Host routes under `/nitui`.
 */
window.__ModuleLoader__.load({
  id: '@zhangxij/dsh-nitui',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'nitui'
    const API = '/nitui'
    const TOTAL = 3
    const RECALL_MODES = [
      ['standard', '标准：同类选择出现时，在对话底部提示'],
      ['premortem-only', '仅明线内展示：不主动提示'],
      ['off', '关闭召回：只记录，不提示'],
    ]
    const SENSITIVITY_MODES = [
      ['strict', '严格：同域 8 条，14 天内不重复'],
      ['standard', '标准：同域 5 条，7 天内不重复'],
      ['eager', '积极：同域 3 条，3 天内不重复'],
    ]

    /* -------------------------------------------------------------- store */

    const store = {
      open: false,
      id: null,
      sessionId: null,
      step: 1,
      q1: '',
      q2: '',
      q3: '',
      question: '',
      lastQ2: '',
      hints: [],
      hintsState: 'idle',
      busy: '',
      error: '',
      note: '',
      result: null,
      collapsed: false,
      settingsOpen: false,
      panelView: 'list',
      layout: { gap: 34, width: 900 },
    }

    const listeners = new Set()
    const emit = () => {
      for (const listener of [...listeners]) listener()
    }
    const patch = (next) => {
      Object.assign(store, next)
      emit()
    }
    const useStore = () => {
      const [, bump] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => {
        listeners.add(bump)
        return () => listeners.delete(bump)
      }, [])
      return store
    }

    let openSettingsPanel = () => {}

    /* ------------------------------------------------------------ helpers */

    async function api(pathname, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(API + pathname, init)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok !== true) {
        throw new Error(data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
      }
      return data
    }

    const ERROR_TEXT = {
      'q1-required': '第①问还没写。',
      'q2-required': '第②问还没写。',
      'session-not-found': '这条推演已经不在了。',
      'llm-unavailable': '当前配置里没有模型。',
      'model-unresolved': '没有可用的模型，先整理你写的内容。',
      'body-too-large': '内容太长了。',
    }
    const errorText = (code) => ERROR_TEXT[code] ?? (code === '' ? '' : `出错了：${code}`)

    const shortTime = (value) => {
      const text = String(value ?? '')
      return text.length >= 16 ? `${text.slice(5, 10)} ${text.slice(11, 16)}` : text
    }
    const STATUS_TEXT = { draft: '进行中', done: '已完成', cancelled: '已取消' }

    function reset() {
      patch({
        open: false,
        id: null,
        sessionId: null,
        step: 1,
        q1: '',
        q2: '',
        q3: '',
        question: '',
        lastQ2: '',
        hints: [],
        hintsState: 'idle',
        busy: '',
        error: '',
        result: null,
        collapsed: false,
        settingsOpen: false,
      })
    }

    let noteTimer = null
    function flashNote(text) {
      patch({ note: text })
      if (noteTimer !== null) clearTimeout(noteTimer)
      noteTimer = setTimeout(() => patch({ note: '' }), 6000)
    }

    function refreshHints(q1) {
      patch({ hints: [], hintsState: 'loading' })
      api('/action', { type: 'hints', q1 })
        .then((result) => {
          const list = Array.isArray(result.hints) ? result.hints : []
          patch({ hints: list, hintsState: list.length > 0 ? 'ready' : 'failed' })
        })
        .catch(() => patch({ hintsState: 'failed' }))
    }

    async function startFromQ1(sessionId) {
      const q1 = store.q1.trim()
      if (q1 === '') {
        patch({ error: 'q1-required' })
        return
      }
      if (store.id !== null) {
        patch({ busy: 'start', error: '' })
        try {
          await api('/action', { type: 'answer', id: store.id, q1 })
          patch({ step: 2, busy: '' })
          refreshHints(q1)
        } catch (error) {
          patch({ busy: '', error: String(error.message) })
        }
        return
      }
      patch({ busy: 'start', error: '' })
      try {
        const data = await api('/action', { type: 'start', q1 })
        patch({ id: data.id, sessionId, step: 2, busy: '' })
        refreshHints(q1)
      } catch (error) {
        patch({ busy: '', error: String(error.message) })
      }
    }

    async function advanceToQ3() {
      const q2 = store.q2.trim()
      if (q2 === '') {
        patch({ error: 'q2-required' })
        return
      }
      if (store.id === null) {
        const q1 = store.q1.trim()
        if (q1 === '') {
          patch({ error: 'q1-required' })
          return
        }
        patch({ busy: 'start', error: '' })
        try {
          const data = await api('/action', { type: 'start', q1 })
          patch({ id: data.id, step: 2, busy: '' })
        } catch (error) {
          patch({ busy: '', error: String(error.message) })
          return
        }
      }
      patch({ busy: 'followup', error: '' })
      try {
        await api('/action', { type: 'answer', id: store.id, q2 })
        if (store.question !== '' && store.lastQ2 === q2) {
          patch({ step: 3, busy: '' })
          return
        }
        const data = await api('/action', { type: 'followup', id: store.id })
        patch({ step: 3, question: data.question, lastQ2: q2, busy: '' })
      } catch (error) {
        patch({ busy: '', error: String(error.message) })
      }
    }

    async function finish(force) {
      const id = store.id
      if (id === null) {
        patch({ error: 'q2-required' })
        return
      }
      if (force !== true && store.q2.trim() === '') {
        patch({ error: 'q2-required' })
        return
      }
      patch({ busy: 'finish', error: '' })
      try {
        const data = await api('/action', { type: 'finish', id, q3: store.q3.trim() })
        patch({
          busy: '',
          open: false,
          collapsed: false,
          result: { title: (data.session && data.session.title) || store.q1.slice(0, 16), card: data.card },
        })
      } catch (error) {
        patch({ busy: '', error: String(error.message) })
      }
    }

    async function cancel() {
      const id = store.id
      if (id !== null) {
        try {
          await api('/action', { type: 'cancel', id })
        } catch {
          /* the note below still tells the truth: this card closed */
        }
      }
      reset()
      flashNote('已取消本次推演')
    }

    function resume(session) {
      if (session.status === 'done' && session.card !== null) {
        patch({
          open: false,
          result: { title: session.title, card: session.card },
          collapsed: false,
          sessionId: null,
          id: session.id,
          error: '',
          busy: '',
        })
        return
      }
      patch({
        open: true,
        sessionId: null,
        id: session.id,
        step: session.q2 === '' ? 2 : 3,
        q1: session.q1,
        q2: session.q2,
        q3: session.q3,
        question: session.question,
        result: null,
        collapsed: false,
        error: '',
        busy: '',
      })
    }

    /* --------------------------------------------------------------- atoms */

    function PressBar(props) {
      const state = useStore()
      const busyCard = state.sessionId === props.sessionId && (state.open || state.result !== null)
      if (busyCard) return null
      const open = () => {
        const sameSession = state.sessionId === props.sessionId
        if (!sameSession) reset()
        patch({
          open: true,
          sessionId: props.sessionId,
          result: sameSession ? state.result : null,
          collapsed: false,
          error: '',
        })
      }
      return h(
        'div',
        { className: 'nt-pressrow', style: { position: 'relative', top: -((state.layout?.gap ?? 34) - 8), marginLeft: 10, display: 'flex', zIndex: 2 } },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'nt-press',
            title: '假设六个月后已经失败，反向推出死因',
            'aria-label': '压一下：开始一次三问推演',
            onClick: open,
          },
          h(
            'svg',
            { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', className: 'nt-press-icon' },
            h('path', { d: 'M8 2.4v7.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
            h('path', { d: 'M4.6 6.6L8 10l3.4-3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('path', { d: 'M3.2 13h9.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
          ),
          h('span', null, '压一下'),
        ),
      )
    }

    /** Reserves real height above the composer so the pill floats in empty space. */
    function PressGap() {
      const state = useStore()
      const gap = (state.layout && state.layout.gap) || 0
      return h('div', { className: 'nt-gap', style: { height: gap } }, h('style', null, CSS))
    }

    function QuestionBlock({ index, label, hint, value, state, onEdit, onJump, children }) {
      const activate = state === 'done' ? onEdit : onJump
      const clickable = typeof activate === 'function'
      return h(
        'div',
        {
          className: `nt-q nt-q--${state}`,
          onClick: clickable ? activate : undefined,
          onKeyDown: clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activate()
                }
              }
            : undefined,
          role: clickable ? 'button' : undefined,
          tabIndex: clickable ? 0 : undefined,
          title: state === 'done' ? '回到这一问修改' : clickable ? '跳到这一问' : undefined,
        },
        h(
          'div',
          { className: 'nt-q-head' },
          h('span', { className: 'nt-q-no' }, index),
          h('span', { className: 'nt-q-label' }, label),
          state === 'done'
            ? h('button', { type: 'button', className: 'nt-q-edit', onClick: onEdit }, '修改')
            : null,
        ),
        state === 'active'
          ? h('div', { className: 'nt-q-panel' }, hint === '' ? null : h('p', { className: 'nt-q-hint' }, hint), children)
          : state === 'done'
            ? h('p', { className: 'nt-q-summary' }, value)
            : h('p', { className: 'nt-q-hint' }, hint),
      )
    }

    function ResultCard({ result, collapsed }) {
      const card = result.card
      const causes = Array.isArray(card.causes) ? card.causes : []
      if (collapsed) {
        return h(
          'div',
          { className: 'nt-summary' },
          h(
            'button',
            { type: 'button', className: 'nt-summary-main', onClick: () => patch({ collapsed: false }), 'aria-expanded': false },
            `▸ 逆推 · ${result.title} · ${causes.length} 条死因`,
          ),
          h('button', { type: 'button', className: 'nt-x', title: '关闭', 'aria-label': '关闭这张卡', onClick: () => reset() }, '×'),
        )
      }
      return h(
        'section',
        { className: 'nt-card nt-card--result', 'aria-label': '逆推卡', style: { maxWidth: store.layout?.width ?? 900 } },
        h(
          'div',
          { className: 'nt-head' },
          h('span', { className: 'nt-brand' }, '逆推卡'),
          h('span', { className: 'nt-sub' }, result.title),
          h('button', {
            type: 'button',
            className: 'nt-x',
            'aria-label': '关闭这张卡',
            title: '关闭（回到未开始的状态）',
            onClick: () => reset(),
          }, '×'),
        ),
        h('p', { className: 'nt-scene' }, card.failureScene),
        card.degraded === true ? h('p', { className: 'nt-warn' }, card.note || '模型暂时不可用，这张卡只整理了你写的内容。') : null,
        h(
          'div',
          { className: 'nt-causes', style: { display: 'block' } },
          causes.map((cause, index) =>
            h(
              'div',
              {
                key: index,
                className: 'nt-cause',
                style: { display: 'block', margin: '0 0 10px', fontSize: 13, lineHeight: 1.65, padding: 0, position: 'static' },
              },
              h('span', { style: { opacity: 0.5, marginRight: 6 } }, `${index + 1}.`),
              h('span', null, cause.text),
              h('span', { className: cause.source === 'ai' ? 'nt-badge nt-badge--ai' : 'nt-badge' }, cause.source === 'ai' ? 'AI 补充' : '你写的'),
              h('br', { key: 'br' }),
              h('span', { style: { display: 'inline', opacity: 0.6, fontSize: 11.5 } }, cause.check),
            ),
          ),
        ),
        card.lean !== null && card.lean !== undefined
          ? h(
              'p',
              { className: 'nt-lean' },
              h('span', { className: 'nt-lean-label' }, '倾向'),
              h('span', null, card.lean.towards),
              h('span', { className: 'nt-lean-note' }, `仅供参考${card.lean.why ? ` · ${card.lean.why}` : ''}`),
            )
          : null,
        card.history !== undefined && card.history !== null
          ? h(
              'div',
              { className: 'nt-history' },
              h('span', { className: 'nt-history-label' }, `同类历史 · ${card.history.domain}`),
              (card.history.lines ?? []).map((line, index) => h('p', { key: index, className: 'nt-history-line' }, line)),
            )
          : null,
        h(
          'div',
          { className: 'nt-foot' },
          h('button', {
            type: 'button',
            className: 'nt-link',
            onClick: () => {
              reset()
              patch({ open: true, step: 1 })
            },
          }, '再压一次'),
          h('span', { className: 'nt-spacer' }),
          h('button', { type: 'button', className: 'nt-link', onClick: () => patch({ collapsed: true }) }, '收起'),
        ),
      )
    }

    function QuickSettings() {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        fetch(`${API}/choices`).then((response) => response.json()).then(setData).catch(() => {})
      }, [])
      const save = (body) => {
        api('/action', { type: 'settings', ...body })
          .then((result) => {
            const layout = result.settings?.layout
            if (layout) patch({ layout })
            setData((current) => (current === null ? current : { ...current, settings: result.settings }))
          })
          .catch(() => {})
      }
      if (data === null) return h('p', { className: 'nt-q-hint' }, '正在读取设置…')
      const dark = data.settings.darkLine
      const layout = data.settings.layout ?? { gap: 34, width: 900 }
      return h(
        'div',
        { className: 'nt-quick' },
        h(
          'div',
          { className: 'nt-quick-row' },
          h('span', { className: 'nt-quick-label' }, '暗线记录与召回'),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': dark.enabled,
              className: dark.enabled ? 'nt-switch nt-switch--on' : 'nt-switch',
              onClick: () => save({ darkLine: { enabled: !dark.enabled } }),
            },
            h('span', { className: 'nt-switch-knob' }),
          ),
        ),
        h(
          'div',
          { className: 'nt-quick-row' },
          h('span', { className: 'nt-quick-label' }, '召回门槛'),
          h(
            'select',
            { className: 'nt-select', value: dark.sensitivity, onChange: (event) => save({ darkLine: { sensitivity: event.target.value } }) },
            SENSITIVITY_MODES.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        h(
          'div',
          { className: 'nt-quick-row' },
          h('span', { className: 'nt-quick-label' }, '卡片宽度'),
          h('input', {
            className: 'nt-number',
            type: 'number',
            min: 560,
            max: 1200,
            defaultValue: layout.width,
            onBlur: (event) => save({ layout: { width: Number(event.target.value) } }),
          }),
        ),
        h(
          'div',
          { className: 'nt-quick-row' },
          h('span', { className: 'nt-quick-label' }, '留空高度'),
          h('input', {
            className: 'nt-number',
            type: 'number',
            min: 0,
            max: 160,
            defaultValue: layout.gap,
            onBlur: (event) => save({ layout: { gap: Number(event.target.value) } }),
          }),
        ),
        h('p', { className: 'nt-quick-foot' },
          h('button', {
            type: 'button',
            className: 'nt-link',
            onClick: () => {
              patch({ settingsOpen: false })
              openSettingsPanel()
            },
          }, '完整设置：域标签、记录列表、导出与清除 →')),
      )
    }

    function CardDock(props) {
      const state = useStore()
      const mine = state.sessionId === null || state.sessionId === props.sessionId
      if (!mine) return null
      if (state.note === '' && state.result === null && !state.open) return null

      const step = state.step
      const busy = state.busy !== ''

      return h(
        'div',
        { className: 'nt-dock' },
        h('style', null, CSS),
        state.note === '' ? null : h('div', { className: 'nt-note', role: 'status' }, state.note),
        state.result !== null ? h(ResultCard, { result: state.result, collapsed: state.collapsed }) : null,
        state.open
          ? h(
              'section',
              { className: 'nt-card', 'aria-label': '逆推三问', style: { maxWidth: state.layout?.width ?? 900 } },
              h('div', {
                className: 'nt-resize',
                title: '拖动调整宽度',
                onPointerDown: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const target = event.currentTarget
                  try {
                    target.setPointerCapture(event.pointerId)
                  } catch {
                    /* capture is best-effort */
                  }
                  const startX = event.clientX
                  const startWidth = store.layout?.width ?? 900
                  document.body.style.cursor = 'col-resize'
                  document.body.style.userSelect = 'none'
                  const onMove = (moveEvent) => {
                    const next = Math.max(560, Math.min(1200, Math.round(startWidth + (moveEvent.clientX - startX))))
                    patch({ layout: { ...store.layout, width: next } })
                  }
                  const onUp = () => {
                    target.removeEventListener('pointermove', onMove)
                    target.removeEventListener('pointerup', onUp)
                    document.body.style.cursor = ''
                    document.body.style.userSelect = ''
                    api('/action', { type: 'settings', layout: { width: store.layout?.width ?? 900 } }).catch(() => {})
                  }
                  target.addEventListener('pointermove', onMove)
                  target.addEventListener('pointerup', onUp)
                },
              }),
              h(
                'div',
                { className: 'nt-head' },
                h('span', { className: 'nt-brand' }, '逆推'),
                h('span', { className: 'nt-sub' }, '三问 · 约 2 分钟'),
                h('button', {
                  type: 'button',
                  className: 'nt-gear',
                  title: '逆推设置',
                  'aria-label': '逆推设置',
                  'aria-expanded': state.settingsOpen,
                  onClick: () => patch({ settingsOpen: !state.settingsOpen }),
                }, '⚙'),
                h(
                  'span',
                  { className: 'nt-dots', 'aria-hidden': 'true' },
                  [1, 2, 3].map((index) => h('span', { key: index, className: index <= step ? 'nt-dot nt-dot--on' : 'nt-dot' })),
                ),
                h('span', { className: 'nt-count' }, `${Math.min(step, TOTAL)} / ${TOTAL}`),
                h('button', {
                  type: 'button',
                  className: 'nt-x',
                  'aria-label': '取消本次推演',
                  title: '取消本次推演',
                  onClick: () => void cancel(),
                }, '×'),
              ),
              state.settingsOpen ? h(QuickSettings) : null,
              h(
                'div',
                { className: 'nt-body', style: state.settingsOpen ? { display: 'none' } : undefined },
                h(
                  QuestionBlock,
                  {
                    index: '①',
                    label: '最近有什么事让你犹豫？',
                    hint: '一句话就行，说那件还没定下来的事；不用分析。',
                    value: state.q1,
                    state: step === 1 ? 'active' : 'done',
                    onEdit: () => patch({ step: 1 }),
                  },
                  h('textarea', {
                    className: 'nt-input',
                    value: state.q1,
                    placeholder: '例如：要不要换工作 / 要不要搬去另一个城市 / 这个项目接不接。',
                    onChange: (event) => patch({ q1: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        event.preventDefault()
                        void startFromQ1(props.sessionId)
                      }
                    },
                    rows: 2,
                  }),
                ),
                h(
                  QuestionBlock,
                  {
                    index: '②',
                    label: '假设六个月后这个决定失败了，最可能的原因是什么？',
                    hint: '写一两条即可，不要求完整。',
                    value: state.q2,
                    state: step === 2 ? 'active' : step > 2 ? 'done' : 'wait',
                    onEdit: () => patch({ step: 2 }),
                    onJump: () => void startFromQ1(props.sessionId),
                  },
                  h('textarea', {
                    className: 'nt-input',
                    value: state.q2,
                    placeholder: '想不出来就先点一个参考，再改成自己的话。',
                    onChange: (event) => patch({ q2: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        event.preventDefault()
                        void advanceToQ3()
                      }
                    },
                    rows: 3,
                  }),
                  state.q2 === '' && state.hintsState !== 'loading'
                    ? h(
                        'div',
                        { className: 'nt-hints' },
                        (state.hints.length > 0
                          ? state.hints
                          : ['其实是我高估了自己的时间', '钱和预算比想的不够', '关键是那个人不一定会配合']
                        ).map((text) =>
                          h('button', { key: text, type: 'button', className: 'nt-hint', onClick: () => patch({ q2: text }) }, text),
                        ),
                      )
                    : null,
                ),
                h(
                  QuestionBlock,
                  {
                    index: '③',
                    label: '一个追问',
                    hint: '可跳过；不答也能出结果。',
                    value: state.q3,
                    state: step === 3 ? 'active' : 'wait',
                    onEdit: () => patch({ step: 3 }),
                    onJump: () => void advanceToQ3(),
                  },
                  h(
                    'div',
                    null,
                    h('p', { className: 'nt-question' }, state.question === '' ? '这次没有生成追问，可以直接出结果。' : state.question),
                    h('textarea', {
                      className: 'nt-input',
                      value: state.q3,
                      placeholder: '可以跳过，直接出结果。',
                      onChange: (event) => patch({ q3: event.target.value }),
                      rows: 2,
                    }),
                  ),
                ),
              ),
              state.error === '' ? null : h('p', { className: 'nt-error', role: 'alert' }, errorText(state.error)),
              h(
                'div',
                { className: 'nt-foot' },
                step > 1 && !busy
                  ? h('button', { type: 'button', className: 'nt-link', onClick: () => patch({ step: step - 1 }) }, '上一步')
                  : h('span'),
                h('span', { className: 'nt-spacer' }),
                busy
                  ? h('span', { className: 'nt-busy', role: 'status' }, state.busy === 'finish' ? '正在生成推演卡…' : state.busy === 'followup' ? '正在想一个追问…' : '正在开始…')
                  : null,
                h('button', {
                  type: 'button',
                  className: 'nt-link',
                  disabled: busy,
                  onClick: () => {
                    if (step === 1) void cancel()
                    else void finish(true)
                  },
                }, '跳过追问'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'nt-primary',
                    disabled: busy,
                    onClick: () => {
                      if (step === 1) void startFromQ1(props.sessionId)
                      else if (step === 2) void advanceToQ3()
                      else void finish(false)
                    },
                  },
                  step === 3 ? '出结果' : '下一步',
                ),
              ),
            )
          : null,
      )
    }

    /* -------------------------------------------------------------- recall */

    function RecallBar(props) {
      const [hint, setHint] = React.useState(null)
      const [hidden, setHidden] = React.useState(false)
      const sessionId = props.sessionId

      React.useEffect(() => {
        let stopped = false
        const tick = () => {
          if (sessionId === undefined || sessionId === null) return
          fetch(`${API}/recall?session=${encodeURIComponent(String(sessionId))}`)
            .then((response) => response.json())
            .then((data) => {
              if (stopped || data === null || data.hint === null || data.hint === undefined) return
              setHint(data.hint)
              setHidden(false)
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 7000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [sessionId])

      if (hint === null || hidden) return null
      const lines = Array.isArray(hint.lines) ? hint.lines.slice(0, 3) : []
      return h(
        'div',
        { className: 'nt-recall', role: 'status' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'nt-recall-head' },
          h('span', { className: 'nt-recall-title' }, '旧账'),
          h('span', { className: 'nt-recall-sub' }, hint.domain),
          h('button', {
            type: 'button',
            className: 'nt-x',
            'aria-label': '这一类的旧账先别再提',
            title: '这一类先别看（7 天内不再提示）',
            onClick: () => {
              setHidden(true)
              const fingerprint = hint.fingerprint
              if (fingerprint) api('/action', { type: 'recall.dismiss', fingerprint }).catch(() => {})
            },
            onClick: () => setHidden(true),
          }, '×'),
        ),
        lines.map((line, index) => h('p', { key: index, className: 'nt-recall-line' }, line)),
        h(
          'div',
          { className: 'nt-recall-foot' },
          h('button', {
            type: 'button',
            className: 'nt-link',
            onClick: () => {
              setHidden(true)
              openSettingsPanel()
            },
          }, '查看全部记录 →'),
        ),
      )
    }

    /* --------------------------------------------------------------- panel */

    function SidebarIcon({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M12.6 5.4a5.6 5.6 0 1 0 1.1 4.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M12.8 1.9v3.7H9.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 7.6, cy: 9.2, r: 1.7, fill: 'currentColor', fillOpacity: 0.6 }),
      )
    }

    function Panel({ onOpenConversation }) {
      const globalState = useStore()
      const [selected, setSelected] = React.useState([])
      const [domainFilter, setDomainFilter] = React.useState('all')
      const [order, setOrder] = React.useState('recent')
      const [state, setState] = React.useState({ loading: true, error: '', sessions: [], ai: null })
      const [filter, setFilter] = React.useState('all')
      const [renaming, setRenaming] = React.useState(null)
      const [renameText, setRenameText] = React.useState('')
      const [pendingDelete, setPendingDelete] = React.useState(null)

      const load = React.useCallback(() => {
        setState((current) => ({ ...current, loading: true, error: '' }))
        api('/state')
          .then((data) => setState({ loading: false, error: '', sessions: data.sessions ?? [], ai: data.ai ?? null }))
          .catch((error) => setState((current) => ({ ...current, loading: false, error: String(error.message) })))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (globalState.panelView === 'settings') {
        return h(
          'div',
          { className: 'nt-panel nt-panel--wide' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'nt-panel-tools nt-panel-tools--top' },
            h('button', { type: 'button', className: 'nt-link', onClick: () => patch({ panelView: 'list' }) }, '← 返回我的推演'),
          ),
          h(SettingsPage),
        )
      }

      const count = (status) => state.sessions.filter((session) => session.status === status).length
      const domains = [...new Set(state.sessions.map((session) => session.domain).filter((name) => typeof name === 'string' && name !== ''))]
      const visible = state.sessions
        .filter((session) => (filter === 'all' || session.status === filter) && (domainFilter === 'all' || session.domain === domainFilter))
        .slice()
        .sort((left, right) => {
          if (order === 'old') return String(left.updatedAt).localeCompare(String(right.updatedAt))
          if (order === 'causes') return (right.card?.causes?.length ?? 0) - (left.card?.causes?.length ?? 0)
          return String(right.updatedAt).localeCompare(String(left.updatedAt))
        })

      const act = (body, after) => {
        api('/action', body)
          .then(() => {
            if (typeof after === 'function') after()
            load()
          })
          .catch((error) => setState((current) => ({ ...current, error: String(error.message) })))
      }

      return h(
        'div',
        { className: 'nt-panel nt-panel--wide' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'nt-panel-head' },
          h(
            'div',
            null,
            h('h1', { className: 'nt-panel-title' }, '我的推演'),
            h('p', { className: 'nt-panel-sub' }, '假设失败、反向推演。列表只在这台机器上，存于 ~/.nitui；版式与暗线设置在「设置 → 逆推」。'),
          ),
          h(
            'div',
            { className: 'nt-panel-tools' },
            state.ai !== null && state.ai.available === false ? h('span', { className: 'nt-chip nt-chip--warn' }, '模型不可用') : null,
            selected.length > 0
              ? h(
                  'span',
                  { className: 'nt-panel-tools' },
                  h('button', { type: 'button', className: 'nt-link', onClick: () => setSelected(visible.map((session) => session.id)) }, '全选当前'),
                  h('button', { type: 'button', className: 'nt-link', onClick: () => setSelected([]) }, '取消选择'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'nt-link nt-link--danger',
                      onClick: () => {
                        const ids = [...selected]
                        Promise.all(ids.map((id) => api('/action', { type: 'delete', id }).catch(() => {}))).then(() => {
                          setSelected([])
                          load()
                        })
                      },
                    },
                    `删除所选 ${selected.length}`,
                  ),
                )
              : null,
            h('button', { type: 'button', className: 'nt-link', onClick: load }, '刷新'),
          ),
        ),
        h(
          'div',
          { className: 'nt-tabs', role: 'tablist' },
          [
            ['all', `全部 ${state.sessions.length}`],
            ['draft', `进行中 ${count('draft')}`],
            ['done', `已完成 ${count('done')}`],
            ['cancelled', `已取消 ${count('cancelled')}`],
          ].map(([id, label]) =>
            h('button', {
              key: id,
              type: 'button',
              role: 'tab',
              className: filter === id ? 'nt-tab nt-tab--on' : 'nt-tab',
              'aria-selected': filter === id,
              onClick: () => setFilter(id),
            }, label),
          ),
        ),
        h(
          'div',
          { className: 'nt-filters' },
          h(
            'select',
            { className: 'nt-select', value: domainFilter, onChange: (event) => setDomainFilter(event.target.value), 'aria-label': '按域筛选' },
            [h('option', { key: 'all', value: 'all' }, '全部域'), ...domains.map((name) => h('option', { key: name, value: name }, name))],
          ),
          h(
            'select',
            { className: 'nt-select', value: order, onChange: (event) => setOrder(event.target.value), 'aria-label': '排序' },
            [['recent', '最近更新'], ['old', '最早更新'], ['causes', '原因最多']].map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        state.error === '' ? null : h('p', { className: 'nt-error', role: 'alert' }, errorText(state.error)),
        state.loading
          ? h('p', { className: 'nt-empty' }, '正在读取本机记录…')
          : visible.length === 0
            ? h('p', { className: 'nt-empty' }, '还没有推演。点输入框上方的「压一下」开始，两分钟一张卡。')
            : h(
                'ul',
                { className: 'nt-rows' },
                visible.map((session) =>
                  h(
                    'li',
                    { key: session.id, className: 'nt-row' },
                    h('input', {
                      type: 'checkbox',
                      className: 'nt-check',
                      'aria-label': `选择「${session.title}」`,
                      checked: selected.includes(session.id),
                      onChange: (event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id),
                        ),
                    }),
                    h(
                      'div',
                      { className: 'nt-row-main' },
                      renaming === session.id
                        ? h('input', {
                            className: 'nt-input nt-input--inline',
                            value: renameText,
                            onChange: (event) => setRenameText(event.target.value),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') act({ type: 'rename', id: session.id, title: renameText }, () => setRenaming(null))
                              else if (event.key === 'Escape') setRenaming(null)
                            },
                          })
                        : h('span', { className: 'nt-row-title' }, session.title),
                      h(
                        'span',
                        { className: 'nt-row-meta' },
                        h('span', { className: `nt-chip nt-chip--${session.status}` }, STATUS_TEXT[session.status] ?? session.status),
                        session.domain !== undefined && session.domain !== '' && session.domain !== '其他'
                          ? h('span', { className: 'nt-chip' }, session.domain)
                          : null,
                        session.status === 'done' && session.card !== null ? ` · ${(session.card.causes ?? []).length} 条原因` : '',
                        ` · ${shortTime(session.updatedAt)}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'nt-row-actions' },
                      pendingDelete === session.id
                        ? [
                            h('button', { key: 'yes', type: 'button', className: 'nt-link nt-link--danger', onClick: () => act({ type: 'delete', id: session.id }, () => setPendingDelete(null)) }, '确认删除'),
                            h('button', { key: 'no', type: 'button', className: 'nt-link', onClick: () => setPendingDelete(null) }, '取消'),
                          ]
                        : [
                            h('button', {
                              key: 'open',
                              type: 'button',
                              className: 'nt-link nt-link--strong',
                              onClick: () => {
                                resume(session)
                                if (typeof onOpenConversation === 'function') onOpenConversation()
                              },
                            }, session.status === 'done' ? '回看' : '继续'),
                            h('button', {
                              key: 'rename',
                              type: 'button',
                              className: 'nt-link',
                              onClick: () => {
                                setRenaming(session.id)
                                setRenameText(session.title)
                              },
                            }, '重命名'),
                            h('button', { key: 'delete', type: 'button', className: 'nt-link', onClick: () => setPendingDelete(session.id) }, '删除'),
                          ],
                    ),
                  ),
                ),
              ),
        h('p', { className: 'nt-panel-foot' }, '关闭窗口不丢：每次点「下一步」都会写进本机。'),
      )
    }

    /* ------------------------------------------------------------- settings */

    function SettingsPage() {
      const [state, setState] = React.useState({
        loading: true,
        error: '',
        choices: [],
        settings: { darkLine: { enabled: true, recall: 'standard', sensitivity: 'standard', domains: [] } },
        diagnostics: { threshold: 5, days: 7, counts: {} },
      })
      const [confirmClear, setConfirmClear] = React.useState(false)

      const load = React.useCallback(() => {
        setState((current) => ({ ...current, loading: true }))
        fetch(`${API}/choices`)
          .then((response) => response.json())
          .then((data) => {
            setState({
              loading: false,
              error: '',
              choices: Array.isArray(data.choices) ? data.choices : [],
              settings: data.settings ?? { darkLine: { enabled: true, recall: 'standard', sensitivity: 'standard', domains: [] } },
              diagnostics: data.diagnostics ?? { threshold: 5, days: 7, counts: {} },
            })
          })
          .catch((error) => setState((current) => ({ ...current, loading: false, error: String(error.message) })))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const save = (darkLine) => {
        setState((current) => ({ ...current, settings: { darkLine: { ...current.settings.darkLine, ...darkLine } } }))
        api('/action', { type: 'settings', darkLine }).then(load).catch((error) => setState((current) => ({ ...current, error: String(error.message) })))
      }

      const saveLayout = (partial) => {
        api('/action', { type: 'settings', layout: partial })
          .then((data) => {
            const layout = data.settings?.layout
            if (layout) {
              patch({ layout })
              setState((current) => ({ ...current, settings: { ...current.settings, layout } }))
            }
          })
          .catch(() => {})
      }

      const removeOne = (id) => {
        api('/action', { type: 'choice.delete', id }).then(load).catch(() => {})
      }

      const clearAll = () => {
        api('/action', { type: 'choices.clear' })
          .then(() => {
            setConfirmClear(false)
            load()
          })
          .catch((error) => setState((current) => ({ ...current, error: String(error.message) })))
      }

      const exportAll = () => {
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), choices: state.choices }, null, 2)
        const blob = new Blob([payload], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'nitui-choices.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      }

      const dark = state.settings.darkLine
      const domains = Array.isArray(dark.domains) ? dark.domains : []
      const domainList = domains.map((name) => {
        const words = Array.isArray(dark.domainWords?.[name]) ? dark.domainWords[name] : []
        return words.length > 0 ? [name, ...words].join('|') : name
      })
      return h(
        'div',
        { className: 'nt-panel' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'nt-panel-head' },
          h(
            'div',
            null,
            h('h1', { className: 'nt-panel-title' }, '逆推'),
            h('p', { className: 'nt-panel-sub' }, '暗线：记录你在取舍上的选择，并在同类选择再次出现时，在对话底部给你看三行旧账。'),
          ),
          h('button', { type: 'button', className: 'nt-link', onClick: load }, '刷新'),
        ),
        state.error === '' ? null : h('p', { className: 'nt-error', role: 'alert' }, state.error),
        h(
          'div',
          { className: 'nt-setting' },
          h(
            'div',
            { className: 'nt-setting-main' },
            h('span', { className: 'nt-setting-label' }, '记录选择并在同类选择上召回'),
            h('span', { className: 'nt-setting-hint' }, '记录只写在本机 ~/.nitui/choices.jsonl，不上传；关掉即停止记录与召回。'),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': dark.enabled,
              className: dark.enabled ? 'nt-switch nt-switch--on' : 'nt-switch',
              onClick: () => save({ enabled: !dark.enabled }),
            },
            h('span', { className: 'nt-switch-knob' }),
          ),
        ),
        h(
          'div',
          { className: 'nt-setting' },
          h(
            'div',
            { className: 'nt-setting-main' },
            h('span', { className: 'nt-setting-label' }, '召回频率'),
            h('span', { className: 'nt-setting-hint' }, '标准会在同类选择出现时提示一次；其余两项只默默记录。'),
          ),
          h(
            'select',
            {
              className: 'nt-select',
              value: dark.recall,
              onChange: (event) => save({ recall: event.target.value }),
            },
            RECALL_MODES.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        h(
          'div',
          { className: 'nt-setting' },
          h(
            'div',
            { className: 'nt-setting-main' },
            h('span', { className: 'nt-setting-label' }, '召回门槛'),
            h('span', { className: 'nt-setting-hint' }, '同域记录攒够这个数才会开始召回；越积极越早出现，也越容易重复。'),
          ),
          h(
            'select',
            {
              className: 'nt-select',
              value: dark.sensitivity,
              onChange: (event) => save({ sensitivity: event.target.value }),
            },
            SENSITIVITY_MODES.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        h(
          'div',
          { className: 'nt-setting nt-setting--stack' },
          h(
            'div',
            { className: 'nt-setting-main' },
            h('span', { className: 'nt-setting-label' }, '域标签'),
            h(
              'span',
              { className: 'nt-setting-hint' },
              `跨域永不召回，只比同一个域里的历史。用逗号分隔；自定义域写成「人际/关系|朋友|边界」，竖线后面是它自己的关键词。当前：${domains.join('、')}`,
            ),
            h('input', {
              key: domainList.join('|'),
              className: 'nt-input nt-input--inline nt-input--wide',
              defaultValue: domainList.join('，'),
              placeholder: '技术/产品，生活/居住，职业/承诺',
              onKeyDown: (event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              },
              onBlur: (event) => {
                const list = event.target.value
                  .split(/[，,、\s]+/)
                  .map((name) => name.trim())
                  .filter((name) => name !== '' && name !== '其他')
                  .slice(0, 12)
                if (list.length > 0) save({ domains: list })
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'nt-setting nt-setting--stack' },
          h(
            'div',
            { className: 'nt-setting-main' },
            h('span', { className: 'nt-setting-label' }, '版式'),
            h('span', { className: 'nt-setting-hint' }, '卡片宽度和输入框上方的留空高度；改完即时生效，下次打开还是这个数。'),
            h(
              'div',
              { className: 'nt-inline' },
              h(
                'label',
                { className: 'nt-field' },
                '卡片宽度',
                h('input', {
                  className: 'nt-number',
                  type: 'number',
                  min: 560,
                  max: 1200,
                  defaultValue: state.settings.layout?.width ?? 900,
                  onBlur: (event) => saveLayout({ width: Number(event.target.value) }),
                }),
              ),
              h(
                'label',
                { className: 'nt-field' },
                '留空高度',
                h('input', {
                  className: 'nt-number',
                  type: 'number',
                  min: 0,
                  max: 160,
                  defaultValue: state.settings.layout?.gap ?? 34,
                  onBlur: (event) => saveLayout({ gap: Number(event.target.value) }),
                }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'nt-subhead' },
          h('span', { className: 'nt-subhead-title' }, '我记录了什么'),
          h('span', { className: 'nt-subhead-count' }, `${state.choices.length} 条`),
        ),
        h(
          'p',
          { className: 'nt-diagnostic' },
          `同域攒到 ${state.diagnostics.threshold} 条才开始召回 · ` +
            (state.choices.length === 0
              ? '还没开始攒。'
              : `目前：${Object.entries(state.diagnostics.counts ?? {}).map(([name, count]) => `${name} ${count}`).join('，')}`),
        ),
        state.loading
          ? h('p', { className: 'nt-empty' }, '正在读取本机记录…')
          : state.choices.length === 0
            ? h('p', { className: 'nt-empty' }, '记录会在你做出选择时产生，目前还没有。')
            : h(
                'ul',
                { className: 'nt-rows' },
                state.choices.map((choice) =>
                  h(
                    'li',
                    { key: choice.id, className: 'nt-row' },
                    h(
                      'div',
                      { className: 'nt-row-main' },
                      h('span', { className: 'nt-row-title' }, choice.chosen),
                      h(
                        'span',
                        { className: 'nt-row-meta' },
                        h('span', { className: 'nt-chip' }, choice.domain),
                        choice.axis === '' ? null : h('span', { className: 'nt-chip' }, choice.axis),
                        h('span', { className: 'nt-chip' }, choice.by === 'model' ? '对话里记的' : '自动推断'),
                        ` · ${shortTime(choice.at)}`,
                        choice.reason && choice.reason.text !== '' ? ` · ${choice.reason.text}` : '',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'nt-row-actions' },
                      h('button', { type: 'button', className: 'nt-link', onClick: () => removeOne(choice.id) }, '删除'),
                    ),
                  ),
                ),
              ),
        h(
          'div',
          { className: 'nt-foot nt-foot--page' },
          h('button', { type: 'button', className: 'nt-link', disabled: state.choices.length === 0, onClick: exportAll }, '导出 JSON'),
          h('span', { className: 'nt-spacer' }),
          confirmClear
            ? [
                h('span', { key: 'warn', className: 'nt-warn' }, '确定清除全部记录？'),
                h('button', { key: 'yes', type: 'button', className: 'nt-link nt-link--danger', onClick: clearAll }, '确认清除'),
                h('button', { key: 'no', type: 'button', className: 'nt-link', onClick: () => setConfirmClear(false) }, '取消'),
              ]
            : h('button', {
                type: 'button',
                className: 'nt-link',
                disabled: state.choices.length === 0,
                onClick: () => setConfirmClear(true),
              }, '清除全部'),
        ),
      )
    }

    /* ----------------------------------------------------------------- css */

    const CSS = `
.nt-dock{display:flex;flex-direction:column;gap:8px;margin:0 0 6px;font-size:13px;line-height:1.6;color:inherit}
.nt-gap{height:34px;width:100%;pointer-events:none}
.nt-pressrow{display:inline-flex;align-items:center}
.nt-press{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:6px;
  border:1px solid rgba(127,127,127,.3);border:1px solid color-mix(in srgb,currentColor 18%,transparent);
  background:rgba(127,127,127,.04);background:color-mix(in srgb,currentColor 3%,transparent);
  color:inherit;font-size:11.5px;line-height:1;cursor:pointer;opacity:.72;white-space:nowrap}
.nt-press:hover{opacity:1;background:rgba(127,127,127,.12);background:color-mix(in srgb,currentColor 8%,transparent)}
.nt-press-icon{opacity:.8}
.nt-card{width:100%;box-sizing:border-box;max-width:720px;margin:0 auto;border-radius:14px;padding:14px 16px;
  border:1px solid rgba(127,127,127,.22);border:1px solid color-mix(in srgb,currentColor 13%,transparent);
  background:rgba(127,127,127,.05);background:color-mix(in srgb,currentColor 3.5%,transparent);
  box-shadow:0 6px 20px rgba(0,0,0,.06)}
.nt-card--result{border-left:3px solid var(--dsw-alias-brand-primary,#2f6fed);overflow:hidden}
.nt-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.nt-brand{font-size:13px;font-weight:600;letter-spacing:.02em}
.nt-sub{font-size:11px;opacity:.55}
.nt-dots{display:inline-flex;gap:3px;margin-left:auto}
.nt-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.18}
.nt-dot--on{opacity:.62}
.nt-count{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums;min-width:30px;text-align:right}
.nt-x{border:0;background:transparent;color:inherit;font-size:15px;line-height:1;opacity:.4;cursor:pointer;padding:0 2px}
.nt-x:hover{opacity:.9}
.nt-body{display:flex;flex-direction:column;gap:8px;min-height:286px}
.nt-q--done,.nt-q--wait{cursor:pointer}
.nt-q--done:hover,.nt-q--wait:hover{background:rgba(127,127,127,.05);background:color-mix(in srgb,currentColor 3.5%,transparent)}
.nt-q{border-radius:10px;padding:8px 10px;border:1px solid transparent}
.nt-q--active{background:rgba(127,127,127,.06);background:color-mix(in srgb,currentColor 4.5%,transparent);
  border-color:rgba(127,127,127,.18);border-color:color-mix(in srgb,currentColor 10%,transparent)}
.nt-q--wait{opacity:.42}
.nt-q-head{display:flex;align-items:baseline;gap:6px}
.nt-q-no{font-size:12px;opacity:.65}
.nt-q-label{font-size:12.5px;font-weight:500}
.nt-q--wait .nt-q-label{font-weight:400}
.nt-q-edit{margin-left:auto;border:0;background:transparent;color:inherit;font-size:11px;opacity:.5;cursor:pointer;padding:0}
.nt-q-edit:hover{opacity:.9;text-decoration:underline}
.nt-q-hint{margin:3px 0 0;font-size:11px;opacity:.55}
.nt-q-panel .nt-q-hint{margin:2px 0 6px}
.nt-q-summary{margin:3px 0 0 20px;font-size:12px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nt-input{width:100%;box-sizing:border-box;margin-top:2px;padding:8px 10px;font:inherit;font-size:13px;color:inherit;
  border:1px solid rgba(127,127,127,.26);border:1px solid color-mix(in srgb,currentColor 15%,transparent);
  border-radius:9px;background:rgba(127,127,127,.04);background:color-mix(in srgb,currentColor 2.5%,transparent);
  resize:vertical;outline:none;line-height:1.6}
.nt-input:focus{border-color:var(--dsw-alias-brand-primary,#2f6fed)}
.nt-input--inline{margin:0;padding:4px 8px;width:60%}
.nt-question{margin:2px 0 6px;padding:8px 10px;border-radius:9px;font-size:12.5px;
  background:rgba(127,127,127,.09);background:color-mix(in srgb,currentColor 5.5%,transparent)}
.nt-foot{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}
.nt-foot--page{margin-top:16px}
.nt-spacer{flex:1}
.nt-primary{height:28px;padding:0 16px;border-radius:8px;border:0;cursor:pointer;font-size:12px;font-weight:500;
  background:var(--dsw-alias-brand-primary,#2f6fed);color:#fff}
.nt-primary:disabled{opacity:.45;cursor:default}
.nt-link{border:0;background:transparent;color:inherit;font-size:12px;opacity:.6;cursor:pointer;padding:2px 0}
.nt-link:hover{opacity:1;text-decoration:underline}
.nt-link:disabled{opacity:.3;cursor:default;text-decoration:none}
.nt-link--strong{opacity:.9;font-weight:500}
.nt-link--danger{color:#c0392b;opacity:.9}
.nt-busy{font-size:11px;opacity:.55}
.nt-error{margin:8px 0 0;font-size:12px;color:#c0392b}
.nt-warn{margin:6px 0;font-size:12px;opacity:.7}
.nt-scene{margin:0 0 10px;font-size:13px}
.nt-causes{list-style:none;margin:0;padding:0}
.nt-cause{position:relative;padding:0 0 0 26px;margin:0 0 10px}
.nt-cause:last-child{margin-bottom:0}
.nt-cause-rank{position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;font-size:11px;display:flex;align-items:center;justify-content:center;
  background:rgba(127,127,127,.16);background:color-mix(in srgb,currentColor 10%,transparent)}
.nt-cause-main{display:block;min-width:0}
.nt-cause-line{display:block}
.nt-cause-text{font-size:13px;overflow-wrap:anywhere}
.nt-badge{display:inline-block;margin-left:6px;vertical-align:1px;font-size:10px;padding:0 6px;border-radius:999px;opacity:.8;line-height:1.6;
  border:1px solid rgba(127,127,127,.4);border:1px solid color-mix(in srgb,currentColor 20%,transparent)}
.nt-badge--ai{border-style:dashed;opacity:.65}
.nt-check{display:block;margin:3px 0 0;font-size:11.5px;opacity:.6;overflow-wrap:anywhere}
.nt-history{margin:12px 0 0;padding:8px 10px;border-radius:9px;font-size:11.5px;opacity:.72;
  border:1px dashed rgba(127,127,127,.3);border:1px dashed color-mix(in srgb,currentColor 16%,transparent)}
.nt-history-label{display:block;font-size:10px;letter-spacing:.06em;opacity:.55;margin-bottom:3px}
.nt-history-line{margin:0;line-height:1.6}
.nt-card{position:relative}
.nt-gear{border:0;background:transparent;color:inherit;font-size:12px;opacity:.4;cursor:pointer;padding:0 2px;line-height:1}
.nt-gear:hover{opacity:.9}
.nt-resize{position:absolute;top:6px;bottom:6px;right:-3px;width:16px;cursor:col-resize;touch-action:none;z-index:5}
.nt-resize::after{content:'';position:absolute;top:0;bottom:0;right:5px;width:2px;border-radius:1px;background:transparent}
.nt-resize:hover::after,.nt-resize:active::after{background:rgba(127,127,127,.4);background:color-mix(in srgb,currentColor 28%,transparent)}
.nt-quick{display:flex;flex-direction:column;gap:10px;padding:4px 0 2px}
.nt-quick-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}
.nt-quick-label{opacity:.7}
.nt-quick-foot{margin:6px 0 0;font-size:11px;opacity:.45}
.nt-hints{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}
.nt-hint{border:1px dashed rgba(127,127,127,.38);border:1px dashed color-mix(in srgb,currentColor 20%,transparent);
  background:transparent;color:inherit;font-size:11px;padding:2px 8px;border-radius:999px;opacity:.55;cursor:pointer}
.nt-hint:hover{opacity:.95}
.nt-inline{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}
.nt-field{display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.65}
.nt-number{width:74px;padding:3px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.3);
  border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px}
.nt-lean{margin:10px 0 0;padding:8px 10px;border-radius:9px;font-size:12px;
  background:rgba(127,127,127,.07);background:color-mix(in srgb,currentColor 4.5%,transparent)}
.nt-lean-label{opacity:.55;margin-right:6px}
.nt-lean-note{margin-left:8px;opacity:.45;font-size:11px}
.nt-summary{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;
  border:1px solid rgba(127,127,127,.22);border:1px solid color-mix(in srgb,currentColor 13%,transparent);
  background:rgba(127,127,127,.05);background:color-mix(in srgb,currentColor 3.5%,transparent);
  border-radius:10px;padding:7px 12px;font-size:12px;color:inherit}
.nt-summary-main{flex:1;min-width:0;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;padding:0}
.nt-summary:hover{background:rgba(127,127,127,.1);background:color-mix(in srgb,currentColor 7%,transparent)}
.nt-summary-mark{margin-right:6px;opacity:.45}
.nt-note{font-size:12px;opacity:.55;text-align:center}
.nt-recall{max-width:720px;margin:0 auto 6px;padding:8px 12px;border-radius:10px;font-size:12px;line-height:1.65;
  border:1px solid rgba(127,127,127,.2);border:1px solid color-mix(in srgb,currentColor 12%,transparent);
  background:rgba(127,127,127,.05);background:color-mix(in srgb,currentColor 3.5%,transparent);color:inherit}
.nt-recall-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.nt-recall-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.45}
.nt-recall-sub{font-size:11px;opacity:.5}
.nt-recall .nt-x{margin-left:auto}
.nt-recall-line{margin:0;opacity:.85}
.nt-panel{padding:22px 26px;width:100%;max-width:none;margin:0 auto;box-sizing:border-box;font-size:13px;color:inherit}
.nt-panel--wide{max-width:none}
.nt-panel-tools--top{justify-content:flex-start;margin-bottom:10px}
.nt-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.nt-panel-title{margin:0;font-size:19px;font-weight:600;letter-spacing:.01em}
.nt-panel-sub{margin:5px 0 0;font-size:12px;opacity:.55;line-height:1.6}
.nt-panel-tools{display:flex;align-items:center;gap:10px}
.nt-chip{font-size:10.5px;padding:0 7px;border-radius:999px;
  border:1px solid rgba(127,127,127,.35);border:1px solid color-mix(in srgb,currentColor 18%,transparent);opacity:.75;line-height:1.7}
.nt-chip--warn{color:#c0392b;border-color:currentColor}
.nt-chip--done{color:var(--dsw-alias-brand-primary,#2f6fed);border-color:currentColor;opacity:1}
.nt-tabs{display:flex;gap:18px;margin:20px 0 4px;
  border-bottom:1px solid rgba(127,127,127,.2);border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.nt-tab{border:0;background:transparent;color:inherit;font-size:12px;padding:7px 0;cursor:pointer;opacity:.5;border-bottom:2px solid transparent}
.nt-tab--on{opacity:1;border-bottom-color:currentColor}
.nt-rows{list-style:none;margin:6px 0 0;padding:0}
.nt-row{display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:10px 2px;
  border-bottom:1px solid rgba(127,127,127,.15);border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}
.nt-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left}
.nt-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nt-row-meta{font-size:11px;opacity:.55;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.nt-filters{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 0}
.nt-recall-foot{display:flex;justify-content:flex-end;margin-top:6px}
.nt-check{width:14px;height:14px;margin:0 2px 0 0;accent-color:var(--dsw-alias-brand-primary,#2f6fed);cursor:pointer;flex:0 0 auto}
.nt-row-actions{display:flex;gap:12px;flex-shrink:0}
.nt-setting{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 2px;
  border-bottom:1px solid rgba(127,127,127,.15);border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);margin-top:14px}
.nt-setting-main{min-width:0;display:flex;flex-direction:column;gap:3px}
.nt-setting--stack{flex-direction:column;align-items:stretch;gap:8px}
.nt-input--wide{width:100%;max-width:560px;margin-top:4px}
.nt-diagnostic{margin:8px 0 0;font-size:11.5px;opacity:.55}
.nt-setting-label{font-size:13px;font-weight:500}
.nt-setting-hint{font-size:11.5px;opacity:.55;line-height:1.55}
.nt-switch{position:relative;flex:0 0 38px;width:38px;height:22px;border-radius:999px;border:1px solid rgba(127,127,127,.35);
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;cursor:pointer;padding:0}
.nt-switch--on{background:var(--dsw-alias-brand-primary,#2f6fed);border-color:transparent}
.nt-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:currentColor;opacity:.6;transition:transform .15s ease}
.nt-switch--on .nt-switch-knob{transform:translateX(16px);background:#fff;opacity:1}
.nt-select{font:inherit;font-size:12px;color:inherit;background:transparent;padding:5px 8px;border-radius:8px;
  border:1px solid rgba(127,127,127,.3);border:1px solid color-mix(in srgb,currentColor 18%,transparent);max-width:280px}
.nt-subhead{display:flex;align-items:baseline;gap:8px;margin:26px 0 2px}
.nt-subhead-title{font-size:13px;font-weight:600}
.nt-subhead-count{font-size:11px;opacity:.5}
.nt-empty{padding:34px 0;text-align:center;font-size:12px;opacity:.5}
.nt-panel-foot{margin:26px 0 0;font-size:11px;opacity:.4}
`

    /* --------------------------------------------------------------- apply */

    function apply(ctx) {
      openSettingsPanel = () => {
        patch({ panelView: 'settings' })
        try {
          ctx.get('layout')?.selectPanel?.(PANEL_ID)
        } catch {
          /* the panel stays reachable from the sidebar entry */
        }
      }
      fetch(`${API}/choices`)
        .then((response) => response.json())
        .then((data) => {
          const layout = data?.settings?.layout
          if (layout && typeof layout.gap === 'number' && typeof layout.width === 'number') patch({ layout })
        })
        .catch(() => {})
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'nitui-gap', order: 29 }, PressGap),
      )
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register({ name: 'conversation.input.overlay', id: 'nitui-press', order: 10 }, PressBar),
      )
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'nitui-card', order: 31 }, CardDock),
      )
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'nitui-recall', order: 30 }, RecallBar),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => '逆推' }, SidebarIcon),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, () =>
          h(Panel, {
            onOpenConversation: () => {
              try {
                ctx.get('layout')?.selectPanel?.('conversation')
              } catch {
                /* the layout service is optional; the card stays queued either way */
              }
            },
          }),
        ),
      )
      // Settings live inside this plugin's own panel now, not in Harness settings.
    }

    return { inject: ['slots'], apply }
  },
})
