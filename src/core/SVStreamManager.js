import { WORKER_MESSAGE_TYPE, IEC61850_CONFIG } from './constants.js'
import {
  createPulseRingBuffer,
  RingBufferReader,
  getPulseStateBuffer,
  OFFSETS,
  RING_BUFFER_CONFIG
} from './SharedRingBuffer.js'
import SVStreamWorker from '../workers/svStream.worker.js?worker'

const MSG = WORKER_MESSAGE_TYPE

export class SVStreamManager {
  constructor(options = {}) {
    this.worker = null
    this.isConnected = false
    this.isInitialized = false
    this.useSharedBuffer = false
    this.zeroCopyMode = false

    this.totalPulses = 0
    this.pulseRate = 0
    this.pulseCountWindow = []

    this.ringBuffer = null
    this.ringReader = null
    this.pulseStateBuffer = null

    this.listeners = {
      pulse: [],
      status: [],
      error: [],
      svData: []
    }

    this.thyristorCount = options.thyristorCount || IEC61850_CONFIG.THYRISTOR_COUNT
    this.instanceIdMap = options.instanceIdMap || null

    this._eventsPool = []
    for (let i = 0; i < 256; i++) {
      this._eventsPool.push({
        thyristorId: 0,
        level: 0,
        meshIndex: 0,
        localIndex: 0,
        isBurst: false,
        timestamp: 0
      })
    }
    this._poolCursor = 0
  }

  async init(config = {}) {
    if (config.thyristorCount) {
      this.thyristorCount = config.thyristorCount
    }

    this.useSharedBuffer = typeof SharedArrayBuffer !== 'undefined'

    if (this.useSharedBuffer) {
      try {
        this.ringBuffer = createPulseRingBuffer()
        this.ringReader = new RingBufferReader(this.ringBuffer)
        this.pulseStateBuffer = getPulseStateBuffer(this.thyristorCount)
        this.zeroCopyMode = true
      } catch (error) {
        console.warn('SharedArrayBuffer 不可用，回退到结构化克隆模式:', error.message)
        this.useSharedBuffer = false
        this.zeroCopyMode = false
      }
    }

    this.worker = new SVStreamWorker()

    this.worker.onmessage = (event) => {
      this._handleMessage(event.data)
    }

    this.worker.onerror = (error) => {
      console.error('Worker 错误:', error)
      this.emit('error', error)
    }

    const initData = {
      thyristorCount: this.thyristorCount,
      wsUrl: config.wsUrl || IEC61850_CONFIG.DEFAULT_WS_URL,
      ...config
    }

    if (this.useSharedBuffer) {
      initData.ringBufferSAB = this.ringBuffer.sab
      initData.pulseStateSAB = this.pulseStateBuffer.sab
    }

    this._send(MSG.INIT, initData)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker 初始化超时'))
      }, 5000)

      const initHandler = (data) => {
        if (data.initialized) {
          clearTimeout(timeout)
          this.isInitialized = true
          if (data.zeroCopy) this.zeroCopyMode = data.zeroCopy
          this.off('status', initHandler)
          resolve(this)
        }
      }
      this.on('status', initHandler)
    })
  }

  connect(options = {}) {
    if (!this.worker) {
      return Promise.reject(new Error('Worker 未初始化'))
    }
    this._send(MSG.CONNECT, options)
    return Promise.resolve()
  }

  disconnect() {
    if (this.worker) {
      this._send(MSG.DISCONNECT)
    }
    this.isConnected = false
  }

  _send(type, data) {
    if (this.worker) {
      this.worker.postMessage({ type, data })
    }
  }

  _handleMessage(message) {
    const { type, data } = message

    switch (type) {
      case MSG.STATUS:
        if (data.connected !== undefined) {
          this.isConnected = data.connected
        }
        if (data.zeroCopy) this.zeroCopyMode = data.zeroCopy
        this.emit('status', data)
        break

      case MSG.PULSE_EVENT:
        this._handleLegacyPulseEvent(data)
        break

      case MSG.SV_DATA:
        this.pulseRate = parseFloat(data.packetRate) || 0
        this.emit('svData', data)
        break

      case MSG.ERROR:
        this.emit('error', data)
        break

      default:
        console.warn('未知的消息类型:', type)
    }
  }

  _handleLegacyPulseEvent(data) {
    if (!data || !data.events || data.events.length === 0) return

    const events = this._acquireEvents(data.events.length)
    for (let i = 0; i < data.events.length; i++) {
      const src = data.events[i]
      const dst = events[i]
      dst.thyristorId = src.thyristorId
      dst.level = src.level
      dst.meshIndex = src.meshIndex ?? 0
      dst.localIndex = src.localIndex ?? src.thyristorId
      dst.isBurst = !!src.isBurst
      dst.timestamp = data.timestamp
    }

    this._processEvents(events, data.events.length)
  }

  drainEvents(outEvents) {
    if (!this.ringReader) return 0
    return this.ringReader.tryRead(outEvents)
  }

  pollRingBuffer() {
    if (!this.ringReader) return null

    const signal = this.ringReader.pollSignal()
    if (signal === 0) return null

    const maxEvents = RING_BUFFER_CONFIG.MAX_EVENTS_PER_SLOT * 8
    const events = this._acquireEvents(maxEvents)
    const count = this.ringReader.tryRead(events)

    if (count > 0) {
      const now = performance.now()
      for (let i = 0; i < count; i++) {
        events[i].timestamp = now
      }
      this._processEvents(events, count)
      return { events, count }
    }

    return null
  }

  getPulseStateBuffer() {
    return this.pulseStateBuffer
  }

  _acquireEvents(count) {
    const result = []
    for (let i = 0; i < count; i++) {
      if (this._poolCursor >= this._eventsPool.length) {
        this._poolCursor = 0
      }
      const evt = this._eventsPool[this._poolCursor++]
      evt.thyristorId = 0
      evt.level = 0
      evt.meshIndex = 0
      evt.localIndex = 0
      evt.isBurst = false
      evt.timestamp = 0
      result.push(evt)
    }
    return result
  }

  _processEvents(events, count) {
    const now = performance.now()

    for (let i = 0; i < count; i++) {
      const evt = events[i]
      if (this.instanceIdMap) {
        const mapping = this.instanceIdMap.get(evt.thyristorId)
        if (mapping) {
          evt.meshIndex = mapping.meshIndex
          evt.localIndex = mapping.localIndex
        }
      }
    }

    this.pulseCountWindow.push({ time: now, count })
    while (this.pulseCountWindow.length > 0 && now - this.pulseCountWindow[0].time > 1000) {
      this.pulseCountWindow.shift()
    }

    this.totalPulses += count

    this.emit('pulse', {
      events,
      count,
      timestamp: now,
      zeroCopy: this.zeroCopyMode
    })
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback)
    }
    return this
  }

  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback)
      if (index > -1) {
        this.listeners[event].splice(index, 1)
      }
    }
    return this
  }

  emit(event, data) {
    if (!this.listeners[event]) return
    const listeners = this.listeners[event]
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](data)
      } catch (error) {
        console.error(`事件监听器错误 [${event}]:`, error)
      }
    }
  }

  getStats() {
    const now = performance.now()
    const windowPulses = this.pulseCountWindow.reduce((sum, p) => sum + p.count, 0)
    const windowDuration = this.pulseCountWindow.length > 0
      ? (now - this.pulseCountWindow[0].time) / 1000
      : 0

    const ringStats = this.ringReader?.getStats() || null

    return {
      connected: this.isConnected,
      initialized: this.isInitialized,
      zeroCopy: this.zeroCopyMode,
      sharedBuffer: this.useSharedBuffer,
      totalPulses: this.totalPulses,
      pulseRatePerSecond: windowDuration > 0 ? windowPulses / windowDuration : 0,
      ringStats
    }
  }

  dispose() {
    this.disconnect()
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.isInitialized = false
    this.isConnected = false
    this.ringBuffer = null
    this.ringReader = null
    this.pulseStateBuffer = null

    Object.keys(this.listeners).forEach(key => {
      this.listeners[key].length = 0
    })

    this._eventsPool.length = 0
    this.pulseCountWindow.length = 0
  }
}

export default SVStreamManager
