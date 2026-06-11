export const RING_BUFFER_CONFIG = {
  SLOT_COUNT: 256,
  MAX_EVENTS_PER_SLOT: 64,
  EVENT_SIZE: 8,
  HEADER_SIZE: 64,
  SIGNAL_NEW_DATA: 1,
  SIGNAL_STOP: 2
}

export const OFFSETS = {
  WRITE_INDEX: 0,
  READ_INDEX: 1,
  SIGNAL: 2,
  PULSE_COUNTER: 3,
  PACKET_COUNTER: 4,
  LAST_TIMESTAMP: 5,
  CURRENT_EVENTS_OFFSET: 6,
  CURRENT_EVENTS_COUNT: 7
}

const { SLOT_COUNT, MAX_EVENTS_PER_SLOT, EVENT_SIZE, HEADER_SIZE } = RING_BUFFER_CONFIG

const SLOT_SIZE = MAX_EVENTS_PER_SLOT * EVENT_SIZE
const TOTAL_HEADER_BYTES = HEADER_SIZE
const TOTAL_DATA_BYTES = SLOT_COUNT * SLOT_SIZE
const TOTAL_BYTES = TOTAL_HEADER_BYTES + TOTAL_DATA_BYTES

export function createPulseRingBuffer() {
  const sab = new SharedArrayBuffer(TOTAL_BYTES)
  
  const headerI32 = new Int32Array(sab, 0, HEADER_SIZE / 4)
  const headerU32 = new Uint32Array(sab, 0, HEADER_SIZE / 4)
  
  Atomics.store(headerI32, OFFSETS.WRITE_INDEX, 0)
  Atomics.store(headerI32, OFFSETS.READ_INDEX, 0)
  Atomics.store(headerI32, OFFSETS.SIGNAL, 0)
  Atomics.store(headerU32, OFFSETS.PULSE_COUNTER, 0)
  Atomics.store(headerU32, OFFSETS.PACKET_COUNTER, 0)
  Atomics.store(headerI32, OFFSETS.LAST_TIMESTAMP, 0)
  Atomics.store(headerI32, OFFSETS.CURRENT_EVENTS_OFFSET, 0)
  Atomics.store(headerI32, OFFSETS.CURRENT_EVENTS_COUNT, 0)

  const dataU8 = new Uint8Array(sab, TOTAL_HEADER_BYTES, TOTAL_DATA_BYTES)
  const dataU16 = new Uint16Array(sab, TOTAL_HEADER_BYTES, TOTAL_DATA_BYTES / 2)
  const dataU32 = new Uint32Array(sab, TOTAL_HEADER_BYTES, TOTAL_DATA_BYTES / 4)
  const dataF32 = new Float32Array(sab, TOTAL_HEADER_BYTES, TOTAL_DATA_BYTES / 4)

  return {
    sab,
    headerI32,
    headerU32,
    dataU8,
    dataU16,
    dataU32,
    dataF32,
    config: { ...RING_BUFFER_CONFIG }
  }
}

export class RingBufferWriter {
  constructor(rb) {
    this.rb = rb
    this.writeIndex = 0
  }

  writeEvents(events, timestamp) {
    const { headerI32, headerU32 } = this.rb
    const writeIdx = Atomics.load(headerI32, OFFSETS.WRITE_INDEX)
    const nextIdx = (writeIdx + 1) % SLOT_COUNT

    this._writeSlot(writeIdx, events)

    Atomics.store(headerI32, OFFSETS.WRITE_INDEX, nextIdx)
    Atomics.store(headerI32, OFFSETS.LAST_TIMESTAMP, Math.floor(timestamp))
    
    if (events.length > 0) {
      Atomics.add(headerU32, OFFSETS.PULSE_COUNTER, events.length)
    }
    Atomics.add(headerU32, OFFSETS.PACKET_COUNTER, 1)

    Atomics.store(headerI32, OFFSETS.SIGNAL, SIGNAL_NEW_DATA)
    Atomics.notify(headerI32, OFFSETS.SIGNAL, 1)
  }

  _writeSlot(slotIndex, events) {
    const slotByteOffset = slotIndex * SLOT_SIZE
    const count = Math.min(events.length, MAX_EVENTS_PER_SLOT)

    for (let i = 0; i < count; i++) {
      const event = events[i]
      const eventByteOffset = slotByteOffset + i * EVENT_SIZE
      const eventU32Offset = eventByteOffset / 4

      this.rb.dataU16[eventByteOffset / 2] = event.thyristorId & 0xFFFF
      this.rb.dataU8[eventByteOffset + 2] = event.level & 0xFF
      this.rb.dataU8[eventByteOffset + 3] = (event.meshIndex || 0) & 0xFF
      this.rb.dataU16[(eventByteOffset + 4) / 2] = (event.localIndex || 0) & 0xFFFF
      this.rb.dataU8[eventByteOffset + 6] = event.isBurst ? 1 : 0
      this.rb.dataU8[eventByteOffset + 7] = 0
    }

    const headerOffset = slotIndex * 2
    this.rb.headerI32[OFFSETS.CURRENT_EVENTS_OFFSET] = slotIndex
    this.rb.headerI32[OFFSETS.CURRENT_EVENTS_COUNT] = count
  }

  sendStopSignal() {
    Atomics.store(this.rb.headerI32, OFFSETS.SIGNAL, SIGNAL_STOP)
    Atomics.notify(this.rb.headerI32, OFFSETS.SIGNAL, 1)
  }
}

export class RingBufferReader {
  constructor(rb) {
    this.rb = rb
    this.readIndex = 0
    this.tmpEvents = new Array(MAX_EVENTS_PER_SLOT)
    for (let i = 0; i < MAX_EVENTS_PER_SLOT; i++) {
      this.tmpEvents[i] = {
        thyristorId: 0,
        level: 0,
        meshIndex: 0,
        localIndex: 0,
        isBurst: false
      }
    }
  }

  tryRead(outEvents) {
    const { headerI32 } = this.rb
    const writeIdx = Atomics.load(headerI32, OFFSETS.WRITE_INDEX)
    const readIdx = this.readIndex

    if (readIdx === writeIdx) {
      return 0
    }

    let totalRead = 0

    while (readIdx !== writeIdx) {
      const count = this._readSlot(readIdx, outEvents, totalRead)
      totalRead += count
      this.readIndex = (this.readIndex + 1) % SLOT_COUNT
    }

    return totalRead
  }

  _readSlot(slotIndex, outEvents, outOffset) {
    const slotByteOffset = slotIndex * SLOT_SIZE
    const count = Atomics.load(this.rb.headerI32, OFFSETS.CURRENT_EVENTS_COUNT)

    for (let i = 0; i < count; i++) {
      const eventByteOffset = slotByteOffset + i * EVENT_SIZE

      const thyristorId = this.rb.dataU16[eventByteOffset / 2]
      const level = this.rb.dataU8[eventByteOffset + 2]
      const meshIndex = this.rb.dataU8[eventByteOffset + 3]
      const localIndex = this.rb.dataU16[(eventByteOffset + 4) / 2]
      const isBurst = this.rb.dataU8[eventByteOffset + 6] === 1

      const evt = outEvents[outOffset + i] || {
        thyristorId: 0, level: 0, meshIndex: 0, localIndex: 0, isBurst: false
      }
      evt.thyristorId = thyristorId
      evt.level = level
      evt.meshIndex = meshIndex
      evt.localIndex = localIndex
      evt.isBurst = isBurst
      outEvents[outOffset + i] = evt
    }

    return count
  }

  async waitForData(timeout = 16) {
    const { headerI32 } = this.rb
    const value = Atomics.load(headerI32, OFFSETS.SIGNAL)
    
    if (value !== 0) {
      Atomics.store(headerI32, OFFSETS.SIGNAL, 0)
      return value
    }

    const result = Atomics.wait(headerI32, OFFSETS.SIGNAL, 0, timeout)
    const finalValue = Atomics.load(headerI32, OFFSETS.SIGNAL)
    Atomics.store(headerI32, OFFSETS.SIGNAL, 0)
    
    return finalValue
  }

  pollSignal() {
    const { headerI32 } = this.rb
    const value = Atomics.exchange(headerI32, OFFSETS.SIGNAL, 0)
    return value
  }

  getStats() {
    return {
      pulseCounter: Atomics.load(this.rb.headerU32, OFFSETS.PULSE_COUNTER),
      packetCounter: Atomics.load(this.rb.headerU32, OFFSETS.PACKET_COUNTER),
      writeIndex: Atomics.load(this.rb.headerI32, OFFSETS.WRITE_INDEX),
      readIndex: this.readIndex
    }
  }
}

export function getPulseStateBuffer(thyristorCount) {
  const stateBytes = thyristorCount
  const intensityBytes = thyristorCount * 4
  
  const sab = new SharedArrayBuffer(stateBytes + intensityBytes)
  const stateU8 = new Uint8Array(sab, 0, stateBytes)
  const intensityF32 = new Float32Array(sab, stateBytes, intensityBytes / 4)

  return {
    sab,
    state: stateU8,
    intensity: intensityF32,
    thyristorCount
  }
}

export function updatePulseState(pulseBuffer, events, decayRate, deltaTime) {
  const { state, intensity, thyristorCount } = pulseBuffer
  const decayFactor = Math.pow(decayRate, deltaTime * 60)

  for (let i = 0; i < thyristorCount; i++) {
    let inten = intensity[i]
    if (inten > 0.001) {
      inten *= decayFactor
      if (inten < 0.001) {
        inten = 0
        state[i] = 0
      }
      intensity[i] = inten
    }
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i]
    const id = evt.thyristorId
    if (id < thyristorCount) {
      state[id] = 1
      intensity[id] = 1.0
    }
  }
}

const SIGNAL_NEW_DATA = RING_BUFFER_CONFIG.SIGNAL_NEW_DATA
const SIGNAL_STOP = RING_BUFFER_CONFIG.SIGNAL_STOP

export default {
  createPulseRingBuffer,
  RingBufferWriter,
  RingBufferReader,
  getPulseStateBuffer,
  updatePulseState,
  RING_BUFFER_CONFIG,
  OFFSETS
}
