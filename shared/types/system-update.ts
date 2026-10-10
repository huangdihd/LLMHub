export type SystemDeployment = 'service' | 'docker' | 'manual' | 'development' | 'unknown'

export interface SystemBuildInformation {
  version: string
  commit: string | null
  deployment: string
}

export interface SystemReleaseCheck {
  status: 'unchecked' | 'current' | 'available' | 'no-releases' | 'failed'
  latestVersion?: string
  tag?: string
  commit?: string
  releaseUrl?: string
  error?: string
  checkedAt?: string
}

export type SystemUpdatePhase = 'downloading' | 'installing' | 'building' | 'switching' | 'restarting' | 'completed' | 'failed'

export interface SystemUpdateStatus {
  phase: SystemUpdatePhase
  tag?: string
  commit?: string
  error?: string
  updatedAt?: string
}

export interface SystemUpdateOverview {
  version: string
  commit: string | null
  deployment: SystemDeployment
  canUpdate: boolean
  command: string | null
  automatic: boolean
  check: SystemReleaseCheck
  update: SystemUpdateStatus | null
}

export interface SystemUpdateSettings {
  automatic: boolean
}
