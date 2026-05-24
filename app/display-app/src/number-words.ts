function consolidate(digits: number[]): number {
  if (digits.length === 0) return 0
  return parseInt([...digits].reverse().join(''))
}

function english(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'],
    ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'],
    ['hundred'],
    ['thousand'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('zero'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) {
      try { if (result[result.length - 1]?.slice(-1) === '-') { result.push(result.pop()! + w[0][d]); break } } catch {}
      result.push(w[0][d]); continue
    }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1) {
      if (digits[pos - 1] > 0 && d !== 0) result.push(w[1][d] + '-')
      else result.push(w[1][d])
      continue
    }
    if (pos === 2 && d !== 0) { result.push(w[0][d] + ' ' + w[2][0]); continue }
    if (pos === 3) {
      if (consolidate(digits) !== 0) { result.push(w[0][d] + ' ' + w[3][0] + ', '); continue }
      else result.push(w[0][d] + ' ' + w[3][0])
    }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + ' ' + w[3])
      if (consolidate(digits) === 0) break
      result.push(result.pop()! + ', ')
    }
  }
  return result
}

function german(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechszehn', 'siebzehn', 'achtzehn', 'neunzehn'],
    ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechszig', 'siebzig', 'achtzig', 'neunzig'],
    ['hundert'],
    ['tausend'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('null'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1 && d !== 0) {
      const pre = digits.pop()!
      const fill = pre !== 0 ? 'und' : ''
      result.push((pre === 1 ? 'ein' : w[0][pre]) + fill + w[1][d])
      break
    }
    if (pos === 2 && d !== 0) { result.push((d === 1 ? 'ein' : w[0][d]) + w[2][0]); continue }
    if (pos === 3 && d !== 0) { result.push((d === 1 ? 'ein' : w[0][d]) + w[3][0]); continue }
    if (pos === 4 && d === 1) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + w[3][0])
    }
  }
  return result
}

function french(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'],
    ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'],
    ['cent', 'cents'],
    ['mille'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('zéro'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1) {
      if (d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
      if (d === 7 || d === 9) { const next = digits.pop()! + 10; result.push(w[1][d] + '-' + w[0][next]); continue }
      const next = digits.pop()!
      result.push(
        w[1][d] +
        (next === 1 && d !== 8 ? ' et ' : '') +
        (next !== 0 && (next !== 1 || d === 8) ? '-' : '') +
        w[0][next]
      )
    }
    if (pos === 2) {
      if (d === 1) { result.push(w[2][0]); continue }
      if (consolidate(digits) === 0) result.push(w[0][d] + ' ' + w[2][1])
      else result.push(w[0][d] + ' ' + w[2][0])
    }
    if (pos === 3) {
      if (d === 1) { result.push(w[3][0]); continue }
      result.push(w[0][d] + ' ' + w[3][0])
    }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + ' ' + w[3][0])
    }
  }
  return result
}

function spanish(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'],
    ['', '', 'veinti', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'],
    ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'],
    ['mil'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('cero'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1 && d !== 0) {
      const post = digits.pop()!
      if (d === 2) {
        if (post === 0) { result.push('veinte'); break }
        const accent: Record<number, string> = { 2: 'dós', 3: 'trés', 6: 'séis' }
        result.push(w[1][d] + (accent[post] ?? w[0][post]))
      } else {
        result.push(w[1][d] + (post !== 0 ? ' y ' : '') + w[0][post])
      }
      break
    }
    if (pos === 2 && d !== 0) {
      if (consolidate(digits) === 0 && d === 1) result.push('cien')
      else result.push(w[2][d])
      continue
    }
    if (pos === 3 && d !== 0) {
      if (d === 1) result.push('mil')
      else result.push(w[0][d] + ' ' + w[3][0])
    }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + ' ' + w[3][0])
    }
  }
  return result
}

function ukrainian(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
    ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'],
    ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'],
  ]
  const result: string[] = []
  if (num === 0) { result.push('ноль'); return result }
  const digits = ('' + num).split('').map(Number).reverse()
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1) { const post = digits.pop()!; result.push(w[1][d] + ' ' + w[0][post]); continue }
    if (pos === 2) { result.push(w[2][d]); continue }
    if (pos === 3) {
      let thousand = 'тысяч'
      if (d < 5) thousand = 'тысячи'
      if (d === 1) thousand = 'тысяча'
      if (d === 2) thousand = 'две тысячи'
      if (d >= 5) thousand = 'тысяч'
      result.push((d !== 1 && d !== 2 ? w[0][d] + ' ' : '') + thousand)
      continue
    }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + ' тысяч')
    }
  }
  return result
}

function hebrew(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'אחת', 'שתים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר', 'אחת-עשרה', 'שתים-עשרה', 'שלוש-עשרה', 'ארבע-עשרה', 'חמש-עשרה', 'שש-עשרה', 'שבע-עשרה', 'שמונה-עשרה', 'תשע-עשרה'],
    ['', 'עשרה', 'עשרים', 'שלושים', 'ארבעים', 'חמשים', 'ששים', 'שבעים', 'שמונים', 'תשעים'],
    ['מאות'],
    ['', 'אלף', 'אלפים', 'שלושת אלפים', 'ארבעת אלפים', 'חמשת אלפים', 'ששת אלפים', 'שבעת אלפים', 'שמונת אלפים', 'תשעת אלפים', 'עשרת אלפים'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('אפס'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1) {
      const n = digits.pop()!
      let ten = w[1][d]
      if (d === 2) ten = 'עשרים'
      if (d === 3 && n === 0) ten = 'שלושים'
      result.push(ten + (n !== 0 ? ' ו' : '') + w[0][n])
      continue
    }
    if (pos === 2) {
      const vav = consolidate(digits) < 10 && consolidate(digits) !== 0 ? ' ו' : ''
      if (d === 1) { result.push('מאה' + vav); continue }
      if (d === 2) { result.push('מאתים' + vav); continue }
      result.push(w[0][d] + ' ' + w[2][0] + vav)
      continue
    }
    if (pos === 3) {
      const vav = consolidate(digits) < 10 && consolidate(digits) !== 0 ? ' ו' : ''
      result.push(w[3][d] + vav)
      continue
    }
    if (pos === 4 && d === 1) {
      const c = parseInt(d + '' + digits.pop())
      const vav = consolidate(digits) < 10 && consolidate(digits) !== 0 ? ' ו' : ''
      if (c === 10) { result.push('עשרת אלפים' + vav); continue }
      result.push(w[0][c] + ' אלף' + vav)
    }
  }
  return result
}

function arabic(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'إحدى عشر', 'إثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'],
    ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'],
    ['', 'مائة', 'مائتان', 'ثلاثمية', 'أربعمية', 'خمسمية', 'ستمية', 'سبعمية', 'ثمانيمية', 'تسعمية'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('صفر'); return result }
  if (digits.length === 1 && digits[0] === 2) { result.push('إثنان'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1 && d === 1) { result.push(w[0][parseInt(d + '' + digits.pop())]); continue }
    if (pos === 1) {
      const n = digits.pop()!
      result.push(w[0][n] + (n !== 0 ? ' و' : '') + w[1][d])
      continue
    }
    if (pos === 2) {
      result.push(w[2][d] + (consolidate(digits) !== 0 ? ' و' : ''))
      continue
    }
    if (pos === 3) {
      if (d === 1) { result.push('ألف'); continue }
      if (d === 2) { result.push('الفا'); continue }
      result.push(w[0][d] + 'الاف ')
      continue
    }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      const vav = consolidate(digits) !== 0 ? ' و' : ''
      if (c === 10) { result.push(w[0][c] + ' آلاف ' + vav); continue }
      result.push(w[0][c] + 'ألف ' + vav)
    }
  }
  return result
}

function mandarin(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'],
    ['十'],
    ['百', '千', '万'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('零'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) {
      try {
        if (consolidate(digits) !== 0 && !result[result.length - 1]?.endsWith('零')) {
          result.push(result.pop()! + '零')
        }
      } catch {}
      continue
    }
    if (pos === 0) { result.push(w[0][d]); continue }
    if (pos === 1) {
      const n = digits.pop()!
      if (d === 1) { result.push(w[1][0] + w[0][n]); continue }
      result.push(w[0][d] + w[1][0] + w[0][n])
      continue
    }
    if (pos === 2) {
      if (consolidate(digits) < 20 && consolidate(digits) > 9) {
        digits.pop()
        result.push(w[0][d] + w[2][0] + w[0][1] + w[1][0])
        continue
      }
      result.push(w[0][d] + w[2][0])
      continue
    }
    if (pos === 3) {
      result.push((num > 10000 ? result.pop()! : '') + w[0][d] + w[2][1])
      continue
    }
    if (pos === 4) {
      result.push(w[0][d] + w[2][2])
    }
  }
  return result
}

function hindi(num: number): string[] {
  if (num > 19999) return []
  const w = [
    ['', 'एक', 'दो', 'तीन', 'चार', 'पांच', 'छह', 'सात', 'आठ', 'नौ', 'दस',
      'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस', 'बीस',
      'इकीस', 'बाईस', 'तेइस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सताइस', 'अट्ठाइस', 'उनतीस', 'तीस',
      'इकतीस', 'बतीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छतीस', 'सैंतीस', 'अड़तीस', 'उनतालीस', 'चालीस',
      'इकतालीस', 'बयालीस', 'तैतालीस', 'चवालीस', 'पैंतालीस', 'छयालिस', 'सैंतालीस', 'अड़तालीस', 'उनचास', 'पचास',
      'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सतावन', 'अठावन', 'उनसठ', 'साठ',
      'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहतर', 'सत्तर',
      'इकहतर', 'बहतर', 'तिहतर', 'चौहतर', 'पचहतर', 'छिहतर', 'सतहतर', 'अठहतर', 'उन्नासी', 'अस्सी',
      'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सतासी', 'अट्ठासी', 'नवासी', 'नब्बे',
      'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सतानवे', 'अट्ठानवे', 'निन्यानवे'],
    ['सौ'],
    ['हज़ार'],
  ]
  const digits = ('' + num).split('').map(Number).reverse()
  const result: string[] = []
  if (digits.length === 1 && digits[0] === 0) { result.push('शून्य'); return result }
  while (digits.length >= 1) {
    const pos = digits.length - 1
    const d = digits.pop()!
    if (d === 0) continue
    if (pos <= 1) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c])
      continue
    }
    if (pos === 2) { result.push(w[0][d] + ' ' + w[1][0]); continue }
    if (pos === 3) { result.push(w[0][d] + ' ' + w[2][0]); continue }
    if (pos === 4) {
      const c = parseInt(d + '' + digits.pop())
      result.push(w[0][c] + ' ' + w[2][0])
    }
  }
  return result
}

export type Language = 'english' | 'german' | 'french' | 'spanish' | 'ukrainian' | 'hebrew' | 'arabic' | 'mandarin' | 'hindi'

export const LANGUAGES: Language[] = [
  'english', 'german', 'hebrew', 'mandarin', 'ukrainian', 'spanish', 'hindi', 'french', 'arabic',
]

const converters: Record<Language, (n: number) => string[]> = {
  english, german, french, spanish, ukrainian, hebrew, arabic, mandarin, hindi,
}

export function numberToWords(num: number, lang: Language): string[] {
  return (converters[lang] ?? english)(num)
}
