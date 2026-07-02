import { ref } from 'vue'
import { csrfFetch } from './csrf-fetch'

export interface ApiError {
  status: number
  message: string
}

function getApiBase(): string {
  return document.documentElement.dataset.apiBase || '/api'
}

export function useApi() {
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  async function get<T>(path: string): Promise<T | null> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`${getApiBase()}${path}`)
      if (!res.ok) {
        error.value = { status: res.status, message: res.statusText }
        return null
      }
      return await res.json() as T
    } catch (e) {
      error.value = { status: 0, message: (e as Error).message }
      return null
    } finally {
      loading.value = false
    }
  }

  async function post<T>(path: string, body?: unknown): Promise<T | null> {
    loading.value = true
    error.value = null
    try {
      const res = await csrfFetch(`${getApiBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        error.value = { status: res.status, message: res.statusText }
        return null
      }
      if (res.status === 201 || res.status === 204) return null
      return await res.json() as T
    } catch (e) {
      error.value = { status: 0, message: (e as Error).message }
      return null
    } finally {
      loading.value = false
    }
  }

  return { get, post, loading, error }
}
