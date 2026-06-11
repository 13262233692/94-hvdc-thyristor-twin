import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { GLTFInstancedLoader } from './GLTFInstancedLoader.js'
import { updateThyristorPulseState, updateThyristorsFromSharedBuffer, createThyristorMaterial } from './ThyristorMaterial.js'
import { SCENE_CONFIG, THYRISTOR_MATERIAL_CONFIG, IEC61850_CONFIG } from './constants.js'

export class SceneManager {
  constructor(container, options = {}) {
    this.container = container
    this.options = {
      enablePostProcessing: true,
      enableBloom: true,
      enableShadow: true,
      antialias: true,
      ...options
    }

    this.scene = null
    this.camera = null
    this.renderer = null
    this.controls = null
    this.composer = null

    this.clock = new THREE.Clock()
    this.isRunning = false
    this.animationFrameId = null

    this.thyristorMeshes = []
    this.instanceIdMap = new Map()
    this.pendingEvents = new Map()
    this.stats = {
      fps: 0,
      frameCount: 0,
      lastFpsTime: 0,
      drawCalls: 0,
      triangles: 0
    }

    this.loadingManager = new THREE.LoadingManager()
    this.gltfLoader = null
    this.modelLoaded = false
    this.modelInfo = null

    this.onModelLoad = null
    this.onStatsUpdate = null
    this.onPulseRendered = null

    this.bloomPass = null
    this.raycaster = new THREE.Raycaster()
    this.mouse = new THREE.Vector2()

    this.pulseStateBuffer = null
    this.zeroCopyMode = false

    this.init()
  }

  init() {
    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(SCENE_CONFIG.BACKGROUND_COLOR)
    this.scene.fog = new THREE.Fog(
      SCENE_CONFIG.FOG_COLOR,
      SCENE_CONFIG.FOG_NEAR,
      SCENE_CONFIG.FOG_FAR
    )

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 2000)
    this.camera.position.set(30, 25, 40)

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.options.antialias,
      powerPreference: 'high-performance',
      alpha: false
    })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    if (this.options.enableShadow) {
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }

    this.container.appendChild(this.renderer.domElement)

    this.setupControls()
    this.setupLights()
    this.setupPostProcessing(width, height)
    this.setupEventListeners()

    this.gltfLoader = new GLTFInstancedLoader(this.loadingManager)
  }

  setupControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.screenSpacePanning = false
    this.controls.minDistance = 5
    this.controls.maxDistance = 200
    this.controls.maxPolarAngle = Math.PI / 2.1
    this.controls.target.set(0, 10, 0)
  }

  setupLights() {
    const ambientLight = new THREE.AmbientLight(0x404080, SCENE_CONFIG.AMBIENT_LIGHT_INTENSITY)
    this.scene.add(ambientLight)

    const mainLight = new THREE.DirectionalLight(0xffffff, SCENE_CONFIG.DIRECTIONAL_LIGHT_INTENSITY)
    mainLight.position.set(50, 80, 50)
    mainLight.castShadow = this.options.enableShadow
    
    if (this.options.enableShadow) {
      mainLight.shadow.mapSize.width = 2048
      mainLight.shadow.mapSize.height = 2048
      mainLight.shadow.camera.near = 0.5
      mainLight.shadow.camera.far = 200
      mainLight.shadow.camera.left = -100
      mainLight.shadow.camera.right = 100
      mainLight.shadow.camera.top = 100
      mainLight.shadow.camera.bottom = -100
      mainLight.shadow.bias = -0.0001
    }
    
    this.scene.add(mainLight)

    const fillLight = new THREE.DirectionalLight(0x88aaff, 0.4)
    fillLight.position.set(-50, 30, -30)
    this.scene.add(fillLight)

    const rimLight = new THREE.DirectionalLight(0xff6644, 0.3)
    rimLight.position.set(0, 50, -50)
    this.scene.add(rimLight)
  }

  setupPostProcessing(width, height) {
    if (!this.options.enablePostProcessing) return

    this.composer = new EffectComposer(this.renderer)
    
    const renderPass = new RenderPass(this.scene, this.camera)
    this.composer.addPass(renderPass)

    if (this.options.enableBloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.8,
        0.4,
        0.85
      )
      this.bloomPass.threshold = 0.3
      this.bloomPass.strength = 1.2
      this.bloomPass.radius = 0.5
      this.composer.addPass(this.bloomPass)
    }

    const outputPass = new OutputPass()
    this.composer.addPass(outputPass)
  }

  setupEventListeners() {
    window.addEventListener('resize', this.onWindowResize.bind(this))
    
    this.loadingManager.onProgress = (url, loaded, total) => {
      const percent = total > 0 ? (loaded / total) * 100 : -1
      if (this.onLoadingProgress) {
        this.onLoadingProgress(percent, url, loaded, total)
      }
    }

    this.loadingManager.onLoad = () => {
      this.modelLoaded = true
      if (this.onModelLoad) {
        this.onModelLoad(this.modelInfo)
      }
    }
  }

  onWindowResize() {
    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(width, height)
    
    if (this.composer) {
      this.composer.setSize(width, height)
    }
  }

  async loadModel(url) {
    try {
      const result = await this.gltfLoader.load(url)
      
      this.scene.add(result.scene)
      this.thyristorMeshes = result.thyristorMeshes
      this.instanceIdMap = result.instanceIdMap
      this.modelInfo = result

      this.autoFitCamera()

      return result
    } catch (error) {
      console.error('模型加载失败:', error)
      throw error
    }
  }

  loadDemoModel(thyristorCount = 2048) {
    const rootGroup = new THREE.Group()
    rootGroup.name = 'DemoValveHall'

    const valveTowerGroup = new THREE.Group()
    valveTowerGroup.name = 'ValveTower'

    const towerHeight = 25
    const towerWidth = 8
    const towerDepth = 6
    const levels = 8
    const thyristorsPerLevel = Math.ceil(thyristorCount / levels)

    const frameGeometry = new THREE.BoxGeometry(0.3, 0.3, towerHeight + 2)
    const frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a5568,
      metalness: 0.8,
      roughness: 0.3
    })

    const framePositions = [
      [-towerWidth / 2, towerHeight / 2, -towerDepth / 2],
      [towerWidth / 2, towerHeight / 2, -towerDepth / 2],
      [-towerWidth / 2, towerHeight / 2, towerDepth / 2],
      [towerWidth / 2, towerHeight / 2, towerDepth / 2]
    ]

    framePositions.forEach(pos => {
      const frame = new THREE.Mesh(frameGeometry, frameMaterial)
      frame.position.set(...pos)
      frame.castShadow = true
      valveTowerGroup.add(frame)
    })

    const thyristorGeometry = new THREE.BoxGeometry(0.6, 0.3, 0.4)
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: THYRISTOR_MATERIAL_CONFIG.BASE_COLOR,
      metalness: 0.6,
      roughness: 0.4
    })

    const instancedMaterial = createThyristorMaterial({
      baseColor: new THREE.Color(THYRISTOR_MATERIAL_CONFIG.BASE_COLOR),
      pulseColor: new THREE.Color(THYRISTOR_MATERIAL_CONFIG.PULSE_COLOR)
    })

    const instancedMesh = new THREE.InstancedMesh(
      thyristorGeometry,
      instancedMaterial,
      thyristorCount
    )
    instancedMesh.name = 'ThyristorInstanced_Demo'
    instancedMesh.castShadow = true
    instancedMesh.receiveShadow = true

    const instanceColor = new Float32Array(thyristorCount * 4)
    const pulseState = new Float32Array(thyristorCount)
    const pulseIntensity = new Float32Array(thyristorCount)

    const dummy = new THREE.Object3D()
    const localIdMap = new Map()

    let globalId = 0

    for (let level = 0; level < levels; level++) {
      const y = (level + 0.5) * (towerHeight / levels) + 0.5
      
      for (let i = 0; i < thyristorsPerLevel && globalId < thyristorCount; i++) {
        const x = (i % 10 - 4.5) * 0.8
        const z = (Math.floor(i / 10) - 1.5) * 0.9

        dummy.position.set(x, y, z)
        dummy.rotation.set(0, Math.PI / 4, 0)
        dummy.updateMatrix()

        instancedMesh.setMatrixAt(globalId, dummy.matrix)

        instanceColor[globalId * 4] = 0.24
        instanceColor[globalId * 4 + 1] = 0.35
        instanceColor[globalId * 4 + 2] = 0.42
        instanceColor[globalId * 4 + 3] = 1.0

        pulseState[globalId] = 0
        pulseIntensity[globalId] = 0

        localIdMap.set(globalId, {
          meshIndex: 0,
          localIndex: globalId
        })

        this.instanceIdMap.set(globalId, {
          meshIndex: 0,
          localIndex: globalId,
          globalInstanceId: globalId
        })

        globalId++
      }
    }

    instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(instanceColor, 4)
    instancedMesh.geometry.setAttribute('aPulseState', new THREE.InstancedBufferAttribute(pulseState, 1))
    instancedMesh.geometry.setAttribute('aPulseIntensity', new THREE.InstancedBufferAttribute(pulseIntensity, 1))

    this.thyristorMeshes.push({
      mesh: instancedMesh,
      material: instancedMaterial,
      count: thyristorCount,
      localIdMap
    })

    valveTowerGroup.add(instancedMesh)

    for (let level = 0; level < levels + 1; level++) {
      const y = level * (towerHeight / levels) + 0.2
      const platformGeo = new THREE.BoxGeometry(towerWidth, 0.15, towerDepth)
      const platformMat = new THREE.MeshStandardMaterial({
        color: 0x2d3748,
        metalness: 0.7,
        roughness: 0.4
      })
      const platform = new THREE.Mesh(platformGeo, platformMat)
      platform.position.set(0, y, 0)
      platform.receiveShadow = true
      platform.castShadow = true
      valveTowerGroup.add(platform)
    }

    rootGroup.add(valveTowerGroup)

    const floorGeo = new THREE.PlaneGeometry(200, 200)
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1a202c,
      metalness: 0.3,
      roughness: 0.8
    })
    const floor = new THREE.Mesh(floorGeo, floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    rootGroup.add(floor)

    this.scene.add(rootGroup)

    this.autoFitCamera()

    this.modelLoaded = true
    this.modelInfo = {
      scene: rootGroup,
      stats: {
        totalMeshes: this.thyristorMeshes.length + 20,
        totalVertices: thyristorCount * 24,
        totalTriangles: thyristorCount * 12,
        thyristorCount,
        insulatorCount: 0,
        pipelineCount: 0,
        drawCallsBefore: thyristorCount,
        drawCallsAfter: 1
      },
      thyristorMeshes: this.thyristorMeshes,
      instanceIdMap: this.instanceIdMap,
      totalThyristors: thyristorCount
    }

    if (this.onModelLoad) {
      this.onModelLoad(this.modelInfo)
    }

    return this.modelInfo
  }

  autoFitCamera() {
    const box = new THREE.Box3()
    box.setFromObject(this.scene)

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())

    const maxDim = Math.max(size.x, size.y, size.z)
    const fov = this.camera.fov * (Math.PI / 180)
    let cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2)))

    cameraZ *= 1.5

    this.camera.position.set(center.x + cameraZ, center.y + cameraZ * 0.6, center.z + cameraZ)
    this.controls.target.copy(center)
    this.controls.update()
  }

  handlePulseEvents(events) {
    if (!events || events.length === 0) return

    for (const event of events) {
      const key = `${event.meshIndex}_${event.localIndex}`
      this.pendingEvents.set(key, event)
    }
  }

  start() {
    if (this.isRunning) return
    this.isRunning = true
    this.clock.start()
    this.animate()
  }

  stop() {
    this.isRunning = false
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  animate() {
    if (!this.isRunning) return

    this.animationFrameId = requestAnimationFrame(this.animate.bind(this))

    const delta = this.clock.getDelta()
    const elapsed = this.clock.getElapsedTime()

    this.controls.update()

    this.updateThyristors(delta, elapsed)

    if (this.composer) {
      this.composer.render()
    } else {
      this.renderer.render(this.scene, this.camera)
    }

    this.updateStats()
  }

  setPulseStateBuffer(buffer) {
    this.pulseStateBuffer = buffer
    this.zeroCopyMode = !!buffer
  }

  updateThyristors(delta, elapsed) {
    if (this.zeroCopyMode && this.pulseStateBuffer) {
      for (let i = 0; i < this.thyristorMeshes.length; i++) {
        const meshData = this.thyristorMeshes[i]
        if (meshData.material.uniforms) {
          meshData.material.uniforms.uTime.value = elapsed
        }
        updateThyristorsFromSharedBuffer(meshData, this.pulseStateBuffer, delta, i)
      }
    } else {
      for (const meshData of this.thyristorMeshes) {
        if (meshData.material.uniforms) {
          meshData.material.uniforms.uTime.value = elapsed
        }

        const localEvents = new Set()
        
        for (const [key, event] of this.pendingEvents) {
          if (event.meshIndex === this.thyristorMeshes.indexOf(meshData)) {
            localEvents.add(event.localIndex)
            this.pendingEvents.delete(key)
          }
        }

        updateThyristorPulseState(meshData, localEvents, delta)
      }
    }
  }

  updateStats() {
    this.stats.frameCount++
    const now = performance.now()

    if (now - this.stats.lastFpsTime >= 1000) {
      this.stats.fps = Math.round(
        this.stats.frameCount * 1000 / (now - this.stats.lastFpsTime)
      )
      this.stats.frameCount = 0
      this.stats.lastFpsTime = now

      if (this.renderer.info) {
        this.stats.drawCalls = this.renderer.info.render.calls
        this.stats.triangles = this.renderer.info.render.triangles
      }

      if (this.onStatsUpdate) {
        this.onStatsUpdate(this.stats)
      }
    }
  }

  getInstanceIdMap() {
    return this.instanceIdMap
  }

  getThyristorCount() {
    return this.modelInfo?.totalThyristors || 0
  }

  getModelStats() {
    return this.modelInfo?.stats || null
  }

  setBloomStrength(strength) {
    if (this.bloomPass) {
      this.bloomPass.strength = strength
    }
  }

  dispose() {
    this.stop()

    window.removeEventListener('resize', this.onWindowResize.bind(this))

    if (this.gltfLoader) {
      this.gltfLoader.dispose()
    }

    this.thyristorMeshes.forEach(({ mesh, material }) => {
      mesh.geometry.dispose()
      material.dispose()
    })

    if (this.bloomPass) {
      this.bloomPass.dispose()
    }

    if (this.composer) {
      this.composer.dispose()
    }

    this.renderer.dispose()

    if (this.renderer.domElement && this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }

    this.scene.traverse((obj) => {
      if (obj.isMesh) {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose())
          } else {
            obj.material.dispose()
          }
        }
      }
    })

    this.controls.dispose()
    this.thyristorMeshes.length = 0
    this.instanceIdMap.clear()
    this.pendingEvents.clear()
  }
}

export default SceneManager
