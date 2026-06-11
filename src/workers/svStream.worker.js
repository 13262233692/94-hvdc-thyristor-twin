import { WORKER_MESSAGE_TYPE, IEC61850_CONFIG } from '../core/constants.js'

let ws = null
let isConnected = false
let isInitialized = false
let reconnectAttempts = 0
let reconnectTimer = null

let ringWriter = null
let pulseStateBuffer = null
let thyristorCount = IEC61850_CONFIG.THYRISTOR_COUNT
let wsUrl = IEC61850_CONFIG.DEFAULT_WS_URL
let simulateMode = false

const MSG = WORKER_MESSAGE_TYPE

const RING_CONFIG = {
  SLOT_COUNT: 256,
  MAX_EVENTS_PER_SLOT: 64,
  EVENT_SIZE: 8,
  HEADER_SIZE: 64,
  SIGNAL_NEW_DATA: 1,
  SIGNAL_STOP: 2
}

const OFFSETS = {
  WRITE_INDEX: 0,
  READ_INDEX: 1,
  SIGNAL: 2,
  PULSE_COUNTER: 3,
  PACKET_COUNTER: 4,
  LAST_TIMESTAMP: 5,
  CURRENT_EVENTS_OFFSET: 6,
  CURRENT_EVENTS_COUNT: 7
}

const SLOT_SIZE = RING_CONFIG.MAX_EVENTS_PER_SLOT * RING_CONFIG.EVENT_SIZE

let headerI32 = null
let headerU32 = null
let dataU8 = null
let dataU16 = null

let pulseStateU8 = null
let pulseIntensityF32 = null

let svPacketCount = 0
let lastStatsTime = 0
let bytesReceived = 0

const tmpEvents = new Array(RING_CONFIG.MAX_EVENTS_PER_SLOT)
for (let i = 0; i < RING_CONFIG.MAX_EVENTS_PER_SLOT; i++) {
  tmpEvents[i] = { thyristorId: 0, level: 0, meshIndex: 0, localIndex: 0, isBurst: false }
}

function post(type, data) {
  self.postMessage({ type, data, timestamp: performance.now() })
}

function initFromBuffers(config) {
  if (!config) return

  if (config.ringBufferSAB) {
    const sab = config.ringBufferSAB
    headerI32 = new Int32Array(sab, 0, RING_CONFIG.HEADER_SIZE / 4)
    headerU32 = new Uint32Array(sab, 0, RING_CONFIG.HEADER_SIZE / 4)
    const dataBytes = RING_CONFIG.SLOT_COUNT * RING_CONFIG.MAX_EVENTS_PER_SLOT * RING_CONFIG.EVENT_SIZE
    dataU8 = new Uint8Array(sab, RING_CONFIG.HEADER_SIZE, dataBytes)
    dataU16 = new Uint16Array(sab, RING_CONFIG.HEADER_SIZE, dataBytes / 2)
  }

  if (config.pulseStateSAB) {
    const sab = config.pulseStateSAB
    const count = config.thyristorCount || thyristorCount
    pulseStateU8 = new Uint8Array(sab, 0, count)
    pulseIntensityF32 = new Float32Array(sab, count, count)
  }

  if (config.thyristorCount) {
    thyristorCount = config.thyristorCount
  }
  if (config.wsUrl) {
    wsUrl = config.wsUrl
  }
}

function writeEventsToRing(events, timestamp) {
  if (!headerI32 || !dataU8) return

  const writeIdx = Atomics.load(headerI32, OFFSETS.WRITE_INDEX)
  const nextIdx = (writeIdx + 1) % RING_CONFIG.SLOT_COUNT

  const count = Math.min(events.length, RING_CONFIG.MAX_EVENTS_PER_SLOT)
  const slotByteOffset = writeIdx * SLOT_SIZE

  for (let i = 0; i < count; i++) {
    const evt = events[i]
    const eventByteOffset = slotByteOffset + i * RING_CONFIG.EVENT_SIZE

    dataU16[eventByteOffset / 2] = evt.thyristorId & 0xFFFF
    dataU8[eventByteOffset + 2] = evt.level & 0xFF
    dataU8[eventByteOffset + 3] = (evt.meshIndex || 0) & 0xFF
    dataU16[(eventByteOffset + 4) / 2] = (evt.localIndex || 0) & 0xFFFF
    dataU8[eventByteOffset + 6] = evt.isBurst ? 1 : 0
    dataU8[eventByteOffset + 7] = 0
  }

  Atomics.store(headerI32, OFFSETS.CURRENT_EVENTS_OFFSET, writeIdx)
  Atomics.store(headerI32, OFFSETS.CURRENT_EVENTS_COUNT, count)

  Atomics.store(headerI32, OFFSETS.WRITE_INDEX, nextIdx)
  Atomics.store(headerI32, OFFSETS.LAST_TIMESTAMP, Math.floor(timestamp))

  if (count > 0) {
    Atomics.add(headerU32, OFFSETS.PULSE_COUNTER, count)
  }
  Atomics.add(headerU32, OFFSETS.PACKET_COUNTER, 1)

  Atomics.store(headerI32, OFFSETS.SIGNAL, RING_CONFIG.SIGNAL_NEW_DATA)
  Atomics.notify(headerI32, OFFSETS.SIGNAL, 1)
}

function updatePulseStateDirect(events) {
  if (!pulseStateU8 || !pulseIntensityF32) return

  for (let i = 0; i < events.length; i++) {
    const id = events[i].thyristorId
    if (id < thyristorCount) {
      pulseStateU8[id] = 1
      pulseIntensityF32[id] = 1.0
    }
  }
}

function decayPulseState(deltaTime, decayRate = 0.92) {
  if (!pulseIntensityF32 || !pulseStateU8) return

  const decayFactor = Math.pow(decayRate, deltaTime * 60)
  for (let i = 0; i < thyristorCount; i++) {
    let inten = pulseIntensityF32[i]
    if (inten > 0.001) {
      inten *= decayFactor
      if (inten < 0.001) {
        inten = 0
        pulseStateU8[i] = 0
      }
      pulseIntensityF32[i] = inten
    }
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  try {
    ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      isConnected = true
      reconnectAttempts = 0
      post(MSG.STATUS, {
        connected: true,
        wsUrl,
        message: 'IEC 61850 SV 流连接成功 (SharedBuffer 模式)'
      })
      lastStatsTime = performance.now()
      startStatsTicker()
    }

    ws.onmessage = (event) => {
      bytesReceived += event.data.byteLength
      svPacketCount++

      const result = parseIEC61850SV(event.data)
      if (result && result.pulseEvents.length > 0) {
        const timestamp = performance.now()
        writeEventsToRing(result.pulseEvents, timestamp)
        updatePulseStateDirect(result.pulseEvents)
      }
    }

    ws.onerror = (error) => {
      post(MSG.ERROR, {
        message: 'WebSocket 错误',
        error: error.message
      })
    }

    ws.onclose = () => {
      isConnected = false
      stopStatsTicker()
      post(MSG.STATUS, {
        connected: false,
        message: '连接断开，尝试重连...'
      })

      if (reconnectAttempts < IEC61850_CONFIG.MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        reconnectTimer = setTimeout(connect, IEC61850_CONFIG.RECONNECT_INTERVAL)
      } else {
        post(MSG.ERROR, {
          message: `已达到最大重连次数 (${IEC61850_CONFIG.MAX_RECONNECT_ATTEMPTS})，停止重连`
        })
      }
    }

  } catch (error) {
    post(MSG.ERROR, {
      message: '连接失败',
      error: error.message
    })
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (ws) {
    ws.close()
    ws = null
  }

  isConnected = false
  reconnectAttempts = 0
  stopStatsTicker()
}

let statsTimer = null

function startStatsTicker() {
  if (statsTimer) return
  statsTimer = setInterval(() => {
    const now = performance.now()
    const duration = (now - lastStatsTime) / 1000
    if (duration > 0) {
      const rate = svPacketCount / duration
      post(MSG.SV_DATA, {
        packetCount: svPacketCount,
        packetRate: rate.toFixed(1),
        bytesReceived,
        bandwidth: (bytesReceived * 8 / 1000000 / duration).toFixed(2),
        zeroCopy: true
      })
    }
    svPacketCount = 0
    bytesReceived = 0
    lastStatsTime = now
  }, 1000)
}

function stopStatsTicker() {
  if (statsTimer) {
    clearInterval(statsTimer)
    statsTimer = null
  }
}

function parseIEC61850SV(buffer) {
  try {
    const view = new DataView(buffer)
    let offset = 0

    if (buffer.byteLength < IEC61850_CONFIG.SV_ID_LENGTH + 4) {
      return null
    }

    const svId = readUTF8String(view, offset, IEC61850_CONFIG.SV_ID_LENGTH)
    offset += IEC61850_CONFIG.SV_ID_LENGTH

    const sampleCount = view.getUint32(offset, false)
    offset += 4

    const count = Math.min(sampleCount, thyristorCount)
    const pulseEvents = []
    const now = performance.now()

    for (let i = 0; i < count; i++) {
      const pulseLevel = view.getUint8(offset + i)
      if (pulseLevel > 127) {
        pulseEvents.push({
          thyristorId: i,
          level: pulseLevel,
          meshIndex: 0,
          localIndex: i,
          isBurst: false
        })
      }
    }

    return { svId, sampleCount, pulseEvents }

  } catch (error) {
    console.error('SV 报文解析失败:', error)
    return null
  }
}

function readUTF8String(view, offset, length) {
  let str = ''
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i)
    if (code === 0) break
    str += String.fromCharCode(code)
  }
  return str
}

function startSimulation() {
  simulateMode = true
  isConnected = true
  isInitialized = true

  post(MSG.STATUS, {
    connected: true,
    wsUrl: 'simulation://shared-buffer',
    message: '模拟模式已启动 (零拷贝 SharedBuffer)',
    zeroCopy: true
  })

  lastStatsTime = performance.now()
  startStatsTicker()
  startSimulatedPackets()
}

let simulationTimer = null

function startSimulatedPackets() {
  const interval = 250
  let packetId = 0

  const tick = () => {
    if (!simulateMode) return

    packetId++
    svPacketCount++

    const events = generateSimulatedPulses()
    const timestamp = performance.now()

    if (events.length > 0) {
      writeEventsToRing(events, timestamp)
      updatePulseStateDirect(events)
    }

    simulationTimer = setTimeout(tick, interval)
  }

  tick()
}

function generateSimulatedPulses() {
  const events = []
  const pulseCount = Math.floor(Math.random() * 8) + 2

  for (let i = 0; i < pulseCount; i++) {
    const id = Math.floor(Math.random() * thyristorCount)
    events.push({
      thyristorId: id,
      level: 255,
      meshIndex: 0,
      localIndex: id,
      isBurst: Math.random() < 0.15
    })
  }

  return events
}

self.onmessage = (event) => {
  const { type, data } = event.data

  switch (type) {
    case MSG.INIT:
      initFromBuffers(data)
      isInitialized = true
      post(MSG.STATUS, {
        initialized: true,
        zeroCopy: true,
        thyristorCount,
        hasRingBuffer: !!headerI32,
        hasPulseState: !!pulseStateU8
      })
      break

    case MSG.CONNECT:
      if (data?.simulate) {
        startSimulation()
      } else {
        if (data?.wsUrl) wsUrl = data.wsUrl
        connect()
      }
      break

    case MSG.DISCONNECT:
      simulateMode = false
      if (simulationTimer) {
        clearTimeout(simulationTimer)
        simulationTimer = null
      }
      disconnect()
      post(MSG.STATUS, {
        connected: false,
        message: '已手动断开连接'
      })
      break

    default:
      console.warn('Worker 未知消息类型:', type)
  }
}
