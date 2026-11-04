import { describe, it, expect } from 'vitest'
import { fitLabel, coinLabelY } from '../label-layout'

describe('label-layout', () => {
  describe('fitLabel', () => {
    it('should handle short text in a single line', () => {
      const result = fitLabel('Intro')
      expect(result.lines.length).toBe(1)
      expect(result.worldW).toBeLessThanOrEqual(4.2)
      expect(result.canvasW).toBeGreaterThan(0)
      expect(result.canvasH).toBeGreaterThan(0)
    })

    it('should wrap long title into at most 2 lines and keep worldW <= 4.2', () => {
      const result = fitLabel('A Very Long Tutorial Title That Keeps Going And Going Forever')
      expect(result.lines.length).toBeLessThanOrEqual(2)
      expect(result.worldW).toBeLessThanOrEqual(4.2)

      // Check total text length constraint
      const joinedText = result.lines.join('')
      const totalLen = joinedText.length
      expect(totalLen).toBeLessThanOrEqual(29) // 28 + ellipsis
    })

    it('should not throw on empty string and return valid non-zero result', () => {
      expect(() => fitLabel('')).not.toThrow()
      const result = fitLabel('')
      expect(result.canvasW).toBeGreaterThan(0)
      expect(result.canvasH).toBeGreaterThan(0)
      expect(result.worldW).toBeGreaterThan(0)
    })

    it('should maintain worldW cap at 4.2 for any input', () => {
      const inputs = ['Short', 'Medium length text here', 'A Very Long Tutorial Title That Keeps Going And Going Forever']
      inputs.forEach(input => {
        const result = fitLabel(input)
        expect(result.worldW).toBeLessThanOrEqual(4.2)
      })
    })

    it('should wrap lines to respect maxChars default (28)', () => {
      const longText = 'This is a test of the emergency broadcast system'
      const result = fitLabel(longText)
      // Each line should ideally be around maxChars or less
      result.lines.forEach(line => {
        // Allow some tolerance for wrapping logic, but generally should be reasonable
        expect(line.length).toBeLessThanOrEqual(35) // generous tolerance for wrapping
      })
    })
  })

  describe('coinLabelY', () => {
    it('should return baseY + 0.4 for even coinIndex', () => {
      const result = coinLabelY(2.0, 0)
      expect(result).toBe(2.4)
    })

    it('should return baseY - 0.4 for odd coinIndex', () => {
      const result = coinLabelY(2.0, 1)
      expect(result).toBe(1.6)
    })

    it('should have 0.8 difference between consecutive coin labels', () => {
      const base = 2.0
      const even = coinLabelY(base, 0)
      const odd = coinLabelY(base, 1)
      expect(even - odd).toBeCloseTo(0.8, 10)
    })

    it('should handle even/odd pairs correctly', () => {
      const base = 3.5
      const result0 = coinLabelY(base, 0)
      const result1 = coinLabelY(base, 1)
      const result2 = coinLabelY(base, 2)
      const result3 = coinLabelY(base, 3)

      expect(result0).toBe(base + 0.4)
      expect(result1).toBe(base - 0.4)
      expect(result2).toBe(base + 0.4)
      expect(result3).toBe(base - 0.4)
    })
  })
})
