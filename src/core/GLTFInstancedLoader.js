import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { THYRISTOR_MATERIAL_CONFIG } from '../core/constants.js'
import { createThyristorMaterial } from './ThyristorMaterial.js'

const THYRISTOR_NAME_PATTERNS = [
  /thyristor/i,
  /晶闸管/i,
  /thy_/i,
  /scr_/i,
  /semiconductor/i
]

const INSULATOR_NAME_PATTERNS = [
  /insulator/i,
  /绝缘子/i,
  /ins_/i
]

const PIPELINE_NAME_PATTERNS = [
  /pipe/i,
  /管线/i,
  /water_cool/i,
  /水冷/i
]

export class GLTFInstancedLoader {
  constructor(manager) {
    this.manager = manager || new THREE.LoadingManager()
    this.gltfLoader = new GLTFLoader(this.manager)
    this.dracoLoader = new DRACOLoader()
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
    this.gltfLoader.setDRACOLoader(this.dracoLoader)

    this.thyristorGeometries = new Map()
    this.thyristorInstances = []
    this.thyristorMeshes = []
    this.instanceIdMap = new Map()
    
    this.onProgress = null
    this.onComplete = null
  }

  load(url) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        url,
        (gltf) => {
          const result = this.processScene(gltf.scene)
          if (this.onComplete) this.onComplete(result)
          resolve(result)
        },
        (xhr) => {
          if (this.onProgress) {
            const percent = xhr.total > 0 ? (xhr.loaded / xhr.total) * 100 : -1
            this.onProgress(percent, xhr.loaded, xhr.total)
          }
        },
        (error) => {
          console.error('GLTF 加载失败:', error)
          reject(error)
        }
      )
    })
  }

  processScene(scene) {
    const stats = {
      totalMeshes: 0,
      totalVertices: 0,
      totalTriangles: 0,
      thyristorCount: 0,
      insulatorCount: 0,
      pipelineCount: 0,
      drawCallsBefore: 0,
      drawCallsAfter: 0
    }

    const tempMatrix = new THREE.Matrix4()
    const collected = {
      thyristors: new Map(),
      insulators: [],
      pipelines: [],
      other: []
    }

    scene.traverse((obj) => {
      if (obj.isMesh) {
        stats.totalMeshes++
        stats.drawCallsBefore++
        
        if (obj.geometry) {
          stats.totalVertices += obj.geometry.attributes.position?.count || 0
          stats.totalTriangles += (obj.geometry.index?.count || obj.geometry.attributes.position?.count) / 3 || 0
        }

        const name = obj.name || ''
        let categorized = false

        for (const pattern of THYRISTOR_NAME_PATTERNS) {
          if (pattern.test(name)) {
            this.collectThyristor(obj, collected.thyristors, tempMatrix)
            stats.thyristorCount++
            categorized = true
            break
          }
        }

        if (!categorized) {
          for (const pattern of INSULATOR_NAME_PATTERNS) {
            if (pattern.test(name)) {
              collected.insulators.push(obj)
              stats.insulatorCount++
              categorized = true
              break
            }
          }
        }

        if (!categorized) {
          for (const pattern of PIPELINE_NAME_PATTERNS) {
            if (pattern.test(name)) {
              collected.pipelines.push(obj)
              stats.pipelineCount++
              categorized = true
              break
            }
          }
        }

        if (!categorized) {
          collected.other.push(obj)
        }
      }
    })

    const rootGroup = new THREE.Group()
    rootGroup.name = 'ValveHallRoot'

    const instancedResult = this.createInstancedMeshes(collected.thyristors, stats)
    rootGroup.add(instancedResult.group)

    const otherGroup = new THREE.Group()
    otherGroup.name = 'OtherStructures'
    
    collected.insulators.forEach(m => {
      m.visible = true
      otherGroup.add(m.clone())
    })
    collected.pipelines.forEach(m => {
      m.visible = true
      otherGroup.add(m.clone())
    })
    collected.other.forEach(m => {
      m.visible = true
      otherGroup.add(m.clone())
    })
    
    rootGroup.add(otherGroup)

    scene.clear()

    return {
      scene: rootGroup,
      stats,
      thyristorMeshes: this.thyristorMeshes,
      instanceIdMap: this.instanceIdMap,
      totalThyristors: this.thyristorInstances.length
    }
  }

  collectThyristor(mesh, thyristorMap, tempMatrix) {
    const geometryKey = this.getGeometryKey(mesh.geometry)
    
    if (!thyristorMap.has(geometryKey)) {
      thyristorMap.set(geometryKey, {
        geometry: mesh.geometry.clone(),
        material: mesh.material,
        transforms: []
      })
    }

    mesh.updateMatrixWorld(true)
    tempMatrix.copy(mesh.matrixWorld)
    
    const instanceId = this.thyristorInstances.length
    this.thyristorInstances.push({
      id: instanceId,
      name: mesh.name,
      matrix: tempMatrix.clone(),
      geometryKey,
      originalMesh: mesh
    })

    thyristorMap.get(geometryKey).transforms.push({
      instanceId,
      matrix: tempMatrix.clone()
    })
  }

  getGeometryKey(geometry) {
    const pos = geometry.attributes.position
    const norm = geometry.attributes.normal
    const uv = geometry.attributes.uv
    const idx = geometry.index

    let key = `v:${pos?.count || 0}`
    if (idx) key += `_i:${idx.count}`
    if (norm) key += `_n`
    if (uv) key += `_uv`
    
    return key
  }

  createInstancedMeshes(thyristorMap, stats) {
    const group = new THREE.Group()
    group.name = 'ThyristorInstances'

    let globalInstanceId = 0

    thyristorMap.forEach((data, key) => {
      const { geometry, transforms } = data
      const count = transforms.length

      if (count === 0) return

      const material = createThyristorMaterial({
        baseColor: new THREE.Color(THYRISTOR_MATERIAL_CONFIG.BASE_COLOR),
        pulseColor: new THREE.Color(THYRISTOR_MATERIAL_CONFIG.PULSE_COLOR)
      })

      const instancedMesh = new THREE.InstancedMesh(geometry, material, count)
      instancedMesh.name = `ThyristorInstanced_${key}`
      instancedMesh.instanceId = this.thyristorMeshes.length

      const instanceColor = new Float32Array(count * 4)
      const pulseState = new Float32Array(count)
      const pulseIntensity = new Float32Array(count)

      const dummy = new THREE.Object3D()
      const localIdMap = new Map()

      transforms.forEach((transform, i) => {
        dummy.matrix.copy(transform.matrix)
        dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale)
        instancedMesh.setMatrixAt(i, dummy.matrix)

        instanceColor[i * 4] = 0.24
        instanceColor[i * 4 + 1] = 0.35
        instanceColor[i * 4 + 2] = 0.42
        instanceColor[i * 4 + 3] = 1.0

        pulseState[i] = 0
        pulseIntensity[i] = 0

        localIdMap.set(transform.instanceId, {
          meshIndex: this.thyristorMeshes.length,
          localIndex: i
        })

        this.instanceIdMap.set(transform.instanceId, {
          meshIndex: this.thyristorMeshes.length,
          localIndex: i,
          globalInstanceId
        })

        globalInstanceId++
      })

      instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(instanceColor, 4)
      instancedMesh.geometry.setAttribute('aPulseState', new THREE.InstancedBufferAttribute(pulseState, 1))
      instancedMesh.geometry.setAttribute('aPulseIntensity', new THREE.InstancedBufferAttribute(pulseIntensity, 1))

      instancedMesh.frustumCulled = false
      instancedMesh.castShadow = true
      instancedMesh.receiveShadow = true

      group.add(instancedMesh)
      this.thyristorMeshes.push({
        mesh: instancedMesh,
        material,
        count,
        localIdMap
      })

      stats.drawCallsAfter++
    })

    return { group }
  }

  getThyristorInstance(globalId) {
    return this.instanceIdMap.get(globalId)
  }

  dispose() {
    this.thyristorMeshes.forEach(({ mesh, material }) => {
      mesh.geometry.dispose()
      material.dispose()
    })
    this.thyristorGeometries.forEach(geo => geo.dispose())
    this.thyristorGeometries.clear()
    this.thyristorInstances.length = 0
    this.thyristorMeshes.length = 0
    this.instanceIdMap.clear()
    this.dracoLoader.dispose()
  }
}

export default GLTFInstancedLoader
