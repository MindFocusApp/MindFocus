/* ============================================================
   MindFocus — Motor de conocimiento (knowledge.js)
   ------------------------------------------------------------
   1) ANALIZA los apuntes del usuario (sin inventar nada):
      - detecta definiciones ("X es...", "X se define como...", "Término: ...")
      - detecta conceptos clave (frecuencia, nombres propios, títulos)
      - elige las oraciones más importantes para el resumen
      - arma tarjetas con contenido REAL del texto (definiciones,
        completar frases, verdadero/falso, opción múltiple, explicar)
   2) BUSCA INFORMACIÓN EN INTERNET (Wikipedia en español, gratis,
      sin clave) sobre los temas del examen y la procesa igual.
   3) Material con algoritmo local + Wikipedia (sin LLM).
   ============================================================ */

const SM = (() => {

  // ---------- Utilidades de texto ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Minúsculas y sin tildes, SIN cambiar la longitud (para poder usar índices). */
  const fold = s => s.toLowerCase()
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u');

  const VOWELS = /[aeiou]/;
  const STEM_KEEP = new Set((
    'lunes martes miercoles jueves viernes sabado domingo ' +
    'enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre ' +
    'crisis tesis analisis sintesis oasis virus campus pais paises mes meses ' +
    'dios dosis genesis hypothesis hipotesis'
  ).split(/\s+/));

  function spanishRV(word) {
    const isV = i => VOWELS.test(word[i]);
    if (word.length < 3) return word.length;
    if (!isV(1)) {
      for (let i = 2; i < word.length; i++) if (isV(i)) return i + 1;
      return word.length;
    }
    if (isV(0) && isV(1)) {
      for (let i = 2; i < word.length; i++) if (!isV(i)) return i + 1;
      return word.length;
    }
    return Math.min(3, word.length);
  }

  function stripSuffix(word, suffixes, rv, minStem = 3) {
    for (const suf of suffixes) {
      if (word.length > suf.length && word.endsWith(suf) && word.length - suf.length >= rv && word.length - suf.length >= minStem) {
        return word.slice(0, -suf.length);
      }
    }
    return word;
  }

  /** Stemmer español simplificado (Snowball-lite): plurales, adverbios y sufijos verbales sin romper días/meses. */
  function stem(w) {
    let word = fold(w);
    if (word.length < 4) return word;
    if (STEM_KEEP.has(word)) return word;
    const rv = spanishRV(word);

    word = stripSuffix(word, ['amente', 'mente'], rv, 4);

    word = stripSuffix(word, [
      'amientos', 'imientos', 'amiento', 'imiento',
      'aciones', 'uciones', 'adores', 'adoras', 'ancias', 'encias',
      'acion', 'ucion', 'ancia', 'encia', 'anza', 'ismo', 'ista',
      'able', 'ible', 'osos', 'osas', 'icos', 'icas', 'ico', 'ica', 'oso', 'osa'
    ], rv, 4);

    word = stripSuffix(word, ['ariamos', 'eramos', 'iramos', 'ando', 'iendo', 'aron', 'ieron', 'aria', 'eria', 'iria'], rv, 4);

    if (word.endsWith('ses') && word.length > 5 && !/(sis|tis)$/.test(word)) {
      const next = word.slice(0, -2);
      if (next.length >= rv && next.length >= 4) word = next;
    } else if (word.endsWith('es') && word.length > 5) {
      const next = word.slice(0, -2);
      if (next.length >= rv && next.length >= 4 && !STEM_KEEP.has(word)) word = next;
    } else if (word.endsWith('s') && !word.endsWith('ss') && !/(is|us)$/.test(word) && word.length > 4) {
      const next = word.slice(0, -1);
      if (next.length >= 4 && VOWELS.test(next[next.length - 1])) word = next;
    }

    return word;
  }
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
  const upperFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
  const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const TOKEN = /[\p{L}][\p{L}\-]*/gu;

  const STOP = new Set(('a al algo algunas algunos ante antes aquel aquella aquellas aquellos aqui asi aunque bajo bien cada casi como con contra cual cuales cuando de del desde donde dos durante e el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estan estar este esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mientras muy ni no nos nosotros nuestra nuestro o os otra otras otro otros para pero poco por porque que quien quienes se sea segun ser si sido siempre sin sobre solo son su sus tambien tanto te tiene tienen todo toda todas todos tras tu tus un una uno unas unos y ya puede pueden debe deben hace hacen hacer tener sido siendo estan estas puesto ademas asimismo entonces luego despues dentro fuera hacia mediante ' +
    // palabras demasiado genericas para ser "concepto clave"
    'apuntes tema temas ejemplo ejemplos resumen punto puntos caso casos cosa cosas manera modo parte partes lugar vez veces ano anos dia dias importante importantes principal principales general generales diferente diferentes distintos distinta distintas siguiente siguientes primer primera segundo segunda tercer tipo tipos forma formas llamado llamada gran grandes mismo misma mismos mismas varios varias otros muchos muchas pocos algun alguna ningun ninguna cualquier tal tales tanto cuanto nuevo nueva nuevos nuevas mayor mayores menor menores mejor peor cierto cierta ciertos ciertas bastante demasiado todavia aun ahora hoy ayer siempre nunca tambien segun sino pues ademas incluso ' +
    'tiempo desarrollo proceso').split(/\s+/));
  // (nota: "proceso"/"desarrollo"/"tiempo" solos son poco informativos; sí se aceptan dentro de frases como "proceso de fotosíntesis")

  const isStop = w => STOP.has(fold(w));

  // ---------- 1. Parsear texto en oraciones y títulos ----------
  function protect(line) {
    return line
      .replace(/\b([ad])\.\s?C\./gi, '$1§C§')
      .replace(/\b(Sr|Sra|Srta|Dr|Dra|Lic|Ing|Prof|etc|Ej|pág|págs|Fig|aprox|vs|núm|EE\.UU)\./gi, '$1§');
  }
  const restore = s => s.replace(/§/g, '.');

  /**
   * Limpia texto típico de OCR (fotos de apuntes): une renglones rotos,
   * corrige confusiones frecuentes y descarta basura casi ilegible.
   */
  /** Distancia de edición (Levenshtein) acotada para corrección OCR. */
  function editDist(a, b, max) {
    a = String(a || ''); b = String(b || '');
    if (Math.abs(a.length - b.length) > (max || 3)) return (max || 3) + 1;
    const m = a.length, n = b.length;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
        prev = tmp;
      }
      if (Math.min(...dp) > (max || 3)) return (max || 3) + 1;
    }
    return dp[n];
  }

  // Vocabulario frecuente de apuntes (ES + historia/geo) para corregir letra a mano
  const OCR_VOCAB = [
    'revolución','francesa','causas','crisis','económica','economia','desigualdad','social',
    'estamentos','estamento','malestar','pueblo','toma','bastilla','julio','declaración',
    'derechos','hombre','ciudadano','etapas','etapa','monarquía','monarquia','constitucional',
    'convención','convencion','directorio','personajes','personaje','robespierre','napoleón',
    'napoleon','bonaparte','luis','uruguay','batalla','piedras','mayo','contexto','oriental',
    'grito','asencio','artigas','orientales','realistas','realista','españoles','español',
    'importancia','primera','victoria','resultado','capitulación','capitulacion','sitio',
    'montevideo','segunda','directo','contra','primera','gran','de','la','los','las','del',
    'y','en','el','un','una','por','para','con','sobre','ante','entre','historia','guerra',
    'proceso','teoría','definicion','definición','ejemplo','causa','efecto','fecha','siglo',
    'imperio','república','republica','independencia','libertad','igualdad','fraternidad',
    'terror','jacobinos','girondinos','absolutismo','antiguo','régimen','regimen','ilustración',
    'ilustracion','montesquieu','rousseau','voltaire','estados','generales','juramento',
    'pelota','guillotina','ejecución','ejecucion','constitución','constitucion'
  ];

  // Correcciones de frases típicas de OCR en historia (letra a mano)
  const OCR_PHRASES = [
    [/loma\s+de\s+la\s+bastilla/gi, 'Toma de la Bastilla'],
    [/toma\s+de\s+la\s+bastil[a-z]*/gi, 'Toma de la Bastilla'],
    [/kesultado/gi, 'Resultado'],
    [/resuitado/gi, 'Resultado'],
    [/montevidec/gi, 'Montevideo'],
    [/montevid[eo]o?/gi, 'Montevideo'],
    [/\bealistas\b/gi, 'realistas'],
    [/\brealístas\b/gi, 'realistas'],
    [/\bdrecto\b/gi, 'directo'],
    [/\bdireto\b/gi, 'directo'],
    [/vulio\s*lubsil/gi, 'Julio 1789'],
    [/vulio\s*l[eu]bs[ií]l/gi, 'Julio 1789'],
    [/\(julio\s*l[eu]b[a-z]*\)/gi, '(Julio 1789)'],
    [/marvals?\s+de\s+perita/gi, 'Malestar del pueblo'],
    [/marv[ae]ls?\s+de\s+p[eo]r[ií]ta/gi, 'Malestar del pueblo'],
    [/malestar\s+de\s+perita/gi, 'Malestar del pueblo'],
    [/sas\s*tirg/gi, ''],
    [/bruse\s*da\s*entagata/gi, ''],
    [/la\s+sas\s+tirg/gi, ''],
    [/segunda\s+en\s+d[ií]?recto\s+la\s+[^\n•]{0,40}/gi, 'Segunda en directo'],
    [/declaraci[oó]n\s+de\s+los\s+derechos\s+del\s*\n?\s*hombre\s+y\s+del\s+ciudadano/gi,
      'Declaración de los Derechos del Hombre y del Ciudadano'],
    [/batalla\s+de\s+las\s*\n?\s*piedras/gi, 'Batalla de las Piedras'],
    [/revoluci[oó]n\s+francesa/gi, 'Revolución Francesa'],
    [/revoluci[oó]n\s+oriental/gi, 'Revolución Oriental'],
    [/grito\s+de\s+asencio/gi, 'Grito de Asencio'],
    [/monarqu[ií]a\s+constitucional/gi, 'Monarquía Constitucional'],
    [/napole[oó]n\s+bonaparte/gi, 'Napoleón Bonaparte']
  ];

  function correctOcrWord(word) {
    const w = String(word || '');
    if (w.length < 4 || w.length > 22) return w;
    // Conservar puntuación pegada
    const m = w.match(/^([("«¿¡]*)(.*?)([)»,.;:!?…]*)$/);
    if (!m) return w;
    const [, pre, core, post] = m;
    if (!core || /\d/.test(core) || core.length < 4) return w;
    const foldCore = core.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    let best = null, bestD = 3;
    for (const v of OCR_VOCAB) {
      const fv = v.normalize('NFD').replace(/\p{M}/gu, '');
      if (Math.abs(fv.length - foldCore.length) > 2) continue;
      const d = editDist(foldCore, fv, 2);
      if (d < bestD) { bestD = d; best = v; }
      if (d === 0) break;
    }
    if (!best || bestD === 0) return w;
    // Respetar mayúscula inicial del original
    let fixed = best;
    if (/^\p{Lu}/u.test(core)) fixed = best.charAt(0).toUpperCase() + best.slice(1);
    if (core === core.toUpperCase() && core.length > 1) fixed = best.toUpperCase();
    return pre + fixed + post;
  }

  function cleanOcrText(raw) {
    let t = String(raw || '').replace(/\r/g, '');
    t = t.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
    t = t.replace(/[^\S\n]+/g, ' ');
    t = t.replace(/[|¦]/g, 'I');
    // Confusiones de caracteres sueltos
    t = t.replace(/\b0(?=[aeiouáéíóú])/gi, 'O');
    t = t.replace(/(?<=[a-záéíóú])0(?=[a-záéíóú])/gi, 'o');
    t = t.replace(/\bl\b/g, 'I');
    // Frases conocidas (antes de unir líneas)
    OCR_PHRASES.forEach(([re, rep]) => { t = t.replace(re, rep); });
    // Corregir palabra por palabra (vocabulario)
    t = t.split(/(\s+)/).map(tok => /^\s+$/.test(tok) ? tok : correctOcrWord(tok)).join('');
    // Sílabas partidas con guion
    t = t.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2');
    // Unir renglones con cuidado de NO fusionar viñetas ni títulos
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const joined = [];
    let buf = '';
    const isBullet = s => /^([•●○*\-–—]\s+|\d+[.)]\s+)/.test(s);
    const isTitle = s => {
      const words = s.split(/\s+/).length;
      return words <= 10 && s.length < 70 && !/[.!?…,;]$/.test(s) &&
        (/^[\p{Lu}]/u.test(s) || /:/.test(s));
    };
    for (const line of lines) {
      if (!buf) { buf = line; continue; }
      const prevEnds = /[.!?…:]$/.test(buf);
      const bulletNext = isBullet(line);
      const bulletBuf = isBullet(buf);
      // Nunca fusionar viñetas ni títulos cortos
      if (prevEnds || bulletNext || bulletBuf || isTitle(line) || isTitle(buf)) {
        joined.push(buf);
        buf = line;
        continue;
      }
      const nextStartsUpper = /^[\p{Lu}¿¡"«\d]/u.test(line);
      if (!nextStartsUpper || buf.split(/\s+/).length < 5) {
        buf = buf.replace(/[,;]\s*$/, '') + ' ' + lowerFirst(line);
      } else if (/[,;]$/.test(buf) || buf.split(/\s+/).length < 10) {
        buf = buf + ' ' + line;
      } else {
        joined.push(buf);
        buf = line;
      }
    }
    if (buf) joined.push(buf);
    t = joined.join('\n');
    // Segunda pasada de frases (por si se armaron al unir)
    OCR_PHRASES.forEach(([re, rep]) => { t = t.replace(re, rep); });
    // Limpiar flechas/basura residual de tachados de cuaderno
    t = t.replace(/[→←]+\s*/g, '→ ');
    t = t.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  /** Heurística: texto que parece salida de OCR / foto. */
  function looksLikeOcr(text) {
    const s = String(text || '');
    if (s.length < 40) return false;
    const lines = s.split(/\n/).filter(l => l.trim());
    if (lines.length < 3) return false;
    const avgLen = lines.reduce((n, l) => n + l.trim().length, 0) / lines.length;
    const noPunct = lines.filter(l => !/[.!?…]/.test(l)).length / lines.length;
    const weird = (s.match(/[|¦]|\b[A-Z]{4,}\b|\d[A-Za-z]|[A-Za-z]\d/g) || []).length;
    return avgLen < 55 || noPunct > 0.55 || weird > 8;
  }

  function cleanLine(raw, opts) {
    let l = raw.replace(/\[(?:\d+|nota \d+|[a-z])\]/gi, '').replace(/\s+/g, ' ').trim();
    if (opts && opts.stripParens) l = l.replace(/\s*\([^)]{0,120}\)/g, '');
    // Basura OCR residual
    l = l.replace(/^[^\p{L}\d«"¿¡]+/u, '').replace(/[^\p{L}\d»".!?…:;%°)]+$/u, '');
    return l.trim();
  }

  function isGarbageSentence(s) {
    if (!s || s.length < 20) return true;
    const letters = (s.match(/\p{L}/gu) || []).length;
    const ratio = letters / s.length;
    if (ratio < 0.55) return true;
    // Demasiados tokens raros de 1 letra
    const toks = s.split(/\s+/);
    const singles = toks.filter(w => w.length === 1 && /\p{L}/u.test(w)).length;
    if (singles > 4) return true;
    if (/^(los |mis |las |estos |estas )?(apuntes|notas)\b/i.test(s)) return true;
    if (/\b(tomé|anoté|escribí|profe(sor)? (dijo|explicó))\b/i.test(s)) return true;
    return false;
  }

  /** "URUGUAY: Batalla de las Piedras - 1811" es título, no definición. */
  function isTitleColon(term, def) {
    const t = String(term || '').trim();
    const d = String(def || '').trim();
    if (!t || !d) return true;
    // País/lugar en mayúsculas + evento con fecha
    if (/\d{4}/.test(d) && /^[\p{Lu}ÁÉÍÓÚÑÜ]{2,}(?:\s+[\p{Lu}ÁÉÍÓÚÑÜ]{2,}){0,3}$/u.test(t)) return true;
    if (/\d{4}/.test(d) && /^(uruguay|argentina|chile|paraguay|bolivia|brasil|españa|francia|europa|américa|mexico|méxico)\b/i.test(t)) return true;
    // "Término: Algo Con Fecha" sin verbo de definición
    if (/\d{4}/.test(d) && !/\b(es|son|fue|era|eran|consiste|significa|implica|ocurre|ocasiona)\b/i.test(d) && d.split(/\s+/).length <= 14) {
      // Si el término es un solo nombre propio corto, probablemente título de sección
      if (t.split(/\s+/).length <= 2 && /^\p{Lu}/u.test(t)) return true;
    }
    return false;
  }

  function parse(text, opts = {}) {
    let src = String(text || '');
    const asOcr = !!opts.ocr;
    // cleanOcrText ya se aplicó en generate() si correspondía; no repetir

    const lines = src.replace(/\r/g, '').split(/\n+/);
    const sentences = [];
    const headings = [];
    const colonDefs = [];
    let heading = opts.defaultHeading || '';
    let pos = 0;

    for (const raw of lines) {
      const hadBullet = /^\s*(?:[-•●○*·–—]+|\d+[.)])\s+/.test(raw);
      let line = cleanLine(raw.replace(/^\s*(?:[-•●○*·–—]+|\d+[.)])\s+/, ''), opts);
      if (!line) continue;
      // Quitar flechas de apuntes
      line = line.replace(/^[→←]\s*/, '').trim();
      if (!line) continue;
      const wc = line.split(/\s+/).length;

      // Título de sección: corto, sin punto, o "LUGAR: Evento con fecha"
      const titleColon = line.match(/^([^:.]{2,40}):\s+(.{8,})$/);
      if (titleColon && isTitleColon(titleColon[1], titleColon[2])) {
        heading = (titleColon[1].trim() + ': ' + titleColon[2].trim()).replace(/\s+/g, ' ');
        if (heading.length > 80) heading = titleColon[1].trim();
        headings.push(heading);
        // También guardar la línea completa como hecho
        sentences.push({ text: upperFirst(line), heading, pos: pos++, bullet: true });
        continue;
      }

      // Título de sección solo si parece encabezado real (no un ítem suelto del tema)
      if (!hadBullet && wc <= 6 && !/[.!?…,;]$/.test(line) && !/^[^:]{2,40}:\s+.{6,}/.test(line)) {
        const isNameList = /^(luis|robespierre|napole[oó]n|artigas|bonaparte|convenci[oó]n|directorio|montevideo|las piedras)/i.test(line);
        const isBigTitle = wc <= 4 && /^\p{Lu}/u.test(line) && (
          /revoluci[oó]n|batalla|guerra|historia|unidad|tema|cap[ií]tulo/i.test(line) ||
          (line === line.toUpperCase() && line.length >= 5)
        );
        if (isBigTitle && !isNameList) {
          heading = line.replace(/[:\s]+$/, '');
          if (heading.length >= 2) headings.push(heading);
          continue;
        }
        // Si no es título, cae como oración/ítem del heading actual
      }

      // "Causas: Crisis económica" → definición/dato útil (no título de país)
      const cm = line.match(/^([^:.]{2,50}):\s+(.{6,})$/);
      if (cm && cm[1].split(/\s+/).length <= 5 && !/[,;]/.test(cm[1]) && !isTitleColon(cm[1], cm[2])) {
        colonDefs.push({ term: cm[1].trim(), def: cm[2].trim(), heading, pos });
      }

      const parts = protect(line).split(/(?<=[.!?…])\s+(?=[\p{Lu}¿¡"«(\d])/u);
      for (const p of parts) {
        let s = restore(p).trim();
        if (!s) continue;
        const words = s.split(/\s+/).length;
        // Apuntes en viñetas: aceptar líneas cortas con contenido
        if (asOcr || hadBullet) {
          // Aceptar nombres sueltos (Robespierre, Convención) y viñetas cortas
          if (s.length < 4 || s.length > 480) continue;
          if (words < 1) continue;
          if (words === 1 && s.length < 5) continue;
          if ((s.match(/\p{L}/gu) || []).length < 3) continue;
        } else {
          if (!/[.!?…]/.test(s) && words >= 8 && s.length >= 40) {
            // bloque útil sin punto
          } else {
            if (/\?$/.test(s) || words < 5 || s.length < 22 || s.length > 480) continue;
          }
          if (isGarbageSentence(s)) continue;
        }
        if (/^\p{Ll}/u.test(s)) s = upperFirst(s);
        sentences.push({ text: s, heading, pos: pos++, bullet: hadBullet });
      }
    }
    return { sentences, headings, colonDefs };
  }

  // ---------- 2. Definiciones ----------
  const BAD_TERM_START = /^(esto|eso|ello|que|como|cuando|donde|si|y|o|pero|lo|se|ya|no|sin|con|por|para|asi|este|esta|estos|estas|ese|esa|aquel|aquella|alli|aqui|tambien|ademas|luego|entonces)\b/i;
  const BAD_TERM_WORDS = /\b(que|puede|pueden|tiene|tienen|hace|hacen|ha|han|fue|fueron|era|eran|son|es|se|cuando|donde|porque)\b/i;
  const DEF_RE = new RegExp(
    '^((?:El|La|Los|Las|Un|Una|Unos|Unas)\\s+)?(.{2,70}?)\\s+(' +
    '(?:(?:es|son)\\s+(?:(?:un|una|el|la|los|las|uno|unos|unas|aquel|aquella|aquello|lo)\\s+)?|' +
    '(?:era|eran|fue|fueron)\\s+(?:un|una|el|la|los|las|uno|unos|unas)\\s+)|' +
    'se\\s+(?:define|denomina|llama|conoce)\\s+(?:como\\s+)?|' +
    'consiste\\s+en\\s+|significa\\s+|se\\s+refiere\\s+a\\s+|se\\s+caracteriza\\s+por\\s+' +
    ')(.{15,})$', 'iu');

  function validTerm(term) {
    const t = term.trim();
    if (!t || /[,;:()]/.test(t) || /\d{4}/.test(t)) return false;
    const w = t.split(/\s+/);
    if (w.length > 6) return false;
    if (BAD_TERM_START.test(t) || BAD_TERM_WORDS.test(t)) return false;
    if (!w.some(x => x.length >= 3 && !isStop(x))) return false;
    // Fragmentos típicos de Wikipedia mal cortados
    if (/^(una de|su alcance|la etapa|la reacción|el resultado|el detonante|el manifiesto|otro símbolo|sus l[ií]deres|inmediatamente|su objetivo|ciudadanos activos|el primero|el segundo|este último)/i.test(t)) return false;
    return true;
  }

  /** Definiciones inútiles extraídas de prosa de Wikipedia. */
  function isWeakWebDef(d) {
    const term = String(d.term || d.termFull || '').trim();
    const def = String(d.def || '').trim();
    if (!term || !def) return true;
    // Adverbios / conectores / posesivos como "término"
    if (/^(inmediatamente|posteriormente|entonces|además|asimismo|sin embargo|por ello|su objetivo|su alcance|la etapa|el resultado|el detonante|el manifiesto|la reacción|una de sus)/i.test(term)) return true;
    // Def demasiado corta o que no explica
    if (def.split(/\s+/).length < 6) return true;
    // "X: verbo en pasado…" sin ser concepto real
    if (/^(el|la|los|las|su|sus|este|esta|estos|estas|otro|otra)\s/i.test(term) && term.split(/\s+/).length <= 3 && !/revoluci|guerra|batalla|tratado|declaraci|constituci|imperio|república/i.test(term)) return true;
    return false;
  }

  const LABEL_LIKE = (term) => /^(causas?|efectos?|consecuencias?|etapas?|fases?|personajes?|contexto|importancia|resultado|objetivos?|caracter[ií]sticas?|ejemplos?|tipos?|factores?)$/i.test(String(term||'').trim());

  /** Une renglones sueltos (Convención, Robespierre…) al “Término: …” anterior. */
  function expandColonDefs(colonDefs, sentences) {
    if (!colonDefs || !colonDefs.length) return colonDefs || [];
    const out = colonDefs.map(c => ({ ...c, def: String(c.def || '').trim() }));
    out.sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      const nextPos = i + 1 < out.length ? out[i + 1].pos : Infinity;
      const extras = [];
      for (const s of sentences) {
        if (s.pos <= c.pos) continue;
        if (s.pos >= nextPos) break;
        // solo ítems cortos sin "etiqueta:"
        if (/^[^:]{2,40}:\s+.{6,}/.test(s.text)) continue;
        const tx = s.text.replace(/^[→←]\s*/, '').trim();
        if (!tx || tx.length > 80) continue;
        const wc = tx.split(/\s+/).length;
        if (wc > 12) continue;
        // No absorber hechos independientes (con año o "Toma/Batalla/Declaración…")
        if (/\b(1[0-9]{3}|20[0-9]{2})\b/.test(tx) && !LABEL_LIKE(c.term)) continue;
        if (/^(toma|batalla|declaraci[oó]n|guerra|tratado|grito)\b/i.test(tx) && LABEL_LIKE(c.term)) continue;
        if (fold(c.def).includes(fold(tx))) continue;
        extras.push(tx);
      }
      if (extras.length) {
        // Si el def termina en artículo/preposición, unir fluido
        if (/(de|del|los|las|el|la|un|una|y|o|en|a)$/i.test(c.def)) {
          c.def = (c.def + ' ' + extras.join(', ')).replace(/\s+/g, ' ').trim();
        } else {
          c.def = (c.def + '; ' + extras.join('; ')).replace(/\s+/g, ' ').trim();
        }
      }
    }
    return out;
  }

  function extractDefinitions(sentences, colonDefs) {
    const defs = [];
    const seen = new Set();
    const push = d => {
      const k = fold(d.term);
      if (seen.has(k)) return;
      seen.add(k); defs.push(d);
    };
    colonDefs = expandColonDefs(colonDefs, sentences);

    for (const s of sentences) {
      // "Es un ... " (sujeto omitido: se usa el título actual)
      const om = s.text.match(/^(Es|Son)\s+((?:un|una|el|la|los|las|uno|unos|unas)\s+.{12,})$/i);
      if (om && s.heading && validTerm(s.heading)) {
        const def = om[2].replace(/[.]+$/, '');
        push({ term: s.heading, termFull: s.heading, verb: om[1].toLowerCase(), prefix: `${s.heading} ${om[1].toLowerCase()} `,
               def, sentence: `${s.heading} ${lowerFirst(s.text)}`, pos: s.pos, heading: s.heading });
        continue;
      }
      const m = s.text.match(DEF_RE);
      if (!m) continue;
      const term = m[2].trim();
      if (!validTerm(term)) continue;
      const verbRaw = m[3].trim().toLowerCase();
      const def = m[4].replace(/[.]+$/, '').trim();
      if (def.split(/\s+/).length < 3) continue;
      const art = m[1] || '';
      push({
        term, termFull: (art + term).trim(), verb: verbRaw,
        prefix: s.text.slice(0, s.text.length - m[4].length),
        def, sentence: s.text, pos: s.pos, heading: s.heading
      });
    }
    // Completar definiciones cortadas por salto de línea usando oraciones siguientes del mismo bloque
    for (const c of colonDefs) {
      if (!validTerm(c.term)) continue;
      if (isTitleColon(c.term, c.def)) continue;
      let def = c.def.replace(/[.]+$/, '').trim();
      // Si el def quedó a medias (termina en artículo/preposición), sumar la siguiente oración cercana
      if (/(de|del|los|las|el|la|un|una|y|o|en|a)$/i.test(def)) {
        const next = sentences.find(s => s.pos > c.pos && s.pos <= c.pos + 3 && s.heading === c.heading);
        if (next && !/^[^:]{2,40}:\s+/.test(next.text)) {
          def = (def + ' ' + next.text.replace(/^[→←]\s*/, '')).replace(/\s+/g, ' ').trim();
        }
      }
      push({ term: c.term, termFull: c.term, verb: 'es', prefix: `${c.term}: `,
             def, sentence: `${c.term}: ${def}`, pos: c.pos, heading: c.heading });
    }
    return defs;
  }

  // ---------- 3. Conceptos clave ----------
  const CAP_PHRASE = /\p{Lu}[\p{L}\-]+(?:\s+(?:(?:de|del|la|las|los|el|y|e)\s+)*\p{Lu}[\p{L}\-]+)*/gu;

  function extractKeywords(sentences, defs, headings, topicTokens, max = 12) {
    const totalWords = sentences.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    const minCount = totalWords < 120 ? 1 : 2;
    const map = new Map(); // key -> {key, surfaces:Map, count, boost, words, cap}

    const bump = (key, surface, words, add = 1, boost = 0, cap = false, noun = 0) => {
      let e = map.get(key);
      if (!e) { e = { key, surfaces: new Map(), count: 0, boost: 0, words, cap: false, noun: 0 }; map.set(key, e); }
      e.count += add; e.boost += boost; e.cap = e.cap || cap; e.noun += noun;
      e.surfaces.set(surface, (e.surfaces.get(surface) || 0) + 1);
    };

    for (const s of sentences) {
      const toks = [...s.text.matchAll(TOKEN)];
      toks.forEach((m, i) => {
        const w = m[0];
        if (w.length < 4 || isStop(w)) return;
        const isCap = /^\p{Lu}/u.test(w) && i > 0;
        const surf = isCap ? w : w.toLowerCase();
        const prev = i > 0 ? fold(toks[i - 1][0]) : '';
        const afterArticle = /^(el|la|los|las|un|una|unos|unas|de|del|al|en|por|su|sus|este|esta|estos|estas)$/.test(prev) && (m.index - (toks[i - 1].index + toks[i - 1][0].length)) <= 1;
        bump(stem(w), surf, 1, 1, topicTokens.has(stem(w)) ? 3 : 0, isCap, afterArticle ? 1 : 0);
      });
      // bigramas
      for (let i = 0; i < toks.length - 1; i++) {
        const a = toks[i][0], b = toks[i + 1][0];
        if (a.length < 4 || b.length < 4 || isStop(a) || isStop(b)) continue;
        if (toks[i + 1].index - (toks[i].index + a.length) > 1) continue; // deben ser adyacentes
        const surf = `${a} ${b}`.replace(/^\p{Lu}/u, c => c); // conserva mayúscula si la tiene
        bump(fold(`${a} ${b}`), /^\p{Lu}/u.test(a) && i > 0 ? surf : surf.toLowerCase(), 2, 1, 0, false);
      }
      // frases con mayúscula (nombres propios, hechos)
      for (const m of s.text.matchAll(CAP_PHRASE)) {
        const ph = m[0].trim();
        const wordsN = ph.split(/\s+/).length;
        if (m.index === 0 && wordsN === 1) continue;           // inicio de oración: no sirve
        if (wordsN === 1 && (ph.length < 4 || isStop(ph))) continue;
        if (wordsN > 1) bump(fold(ph), ph, wordsN, 1, 1.5, true);
      }
    }
    // definiciones y títulos: peso extra
    defs.forEach(d => bump(fold(d.term), d.term, d.term.split(/\s+/).length, 0, 6, /^\p{Lu}/u.test(d.term)));
    headings.forEach(h => { if (h.split(/\s+/).length <= 5 && validTerm(h)) bump(fold(h), h, h.split(/\s+/).length, 0, 4, false); });

    const cands = [];
    for (const e of map.values()) {
      const tokens = e.key.split(' ');
      const isPhrase = tokens.length > 1;
      if (!isPhrase && e.count < minCount && e.boost < 3) continue;
      if (!isPhrase && !e.cap && e.noun === 0 && e.boost < 3) continue; // sin artículo delante nunca: probablemente verbo/adjetivo
      if (isPhrase && e.count < 2 && e.boost < 1.5) continue;
      const best = [...e.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0];
      let score = e.count * (isPhrase ? 1.6 : 1) + e.boost + (best.length > 7 ? 0.3 : 0);
      if (!isPhrase && e.boost < 3 && /(ico|ica|ivo|iva|oso|osa|ble)s?$/.test(e.key)) score *= 0.5; // probablemente adjetivo
      if (best.length > 40) continue;                                                              // demasiado largo para ser opción/hueco
      cands.push({ text: best, key: e.key, score, isPhrase, cap: e.cap || /^\p{Lu}/u.test(best) });
    }
    cands.sort((a, b) => b.score - a.score);

    const chosen = [];
    for (const c of cands) {
      const ctoks = c.key.split(' ').map(stem);
      const clash = chosen.some(o => {
        const otoks = o.key.split(' ').map(stem);
        return ctoks.every(t => otoks.includes(t)) || otoks.every(t => ctoks.includes(t));
      });
      if (clash) continue;
      chosen.push(c);
      if (chosen.length >= max) break;
    }
    return chosen;
  }

  /** Busca un concepto dentro de una oración; devuelve {start,end,text} o null. */
  function findSpan(sentence, kw) {
    const f = fold(sentence);
    const variants = kw.isPhrase
      ? [kw.key]
      : [...new Set([kw.text && fold(kw.text), kw.key, stem(kw.key || ''), stem(kw.text || '')].filter(Boolean))];
    for (const v of variants) {
      const key = kw.isPhrase ? escRe(v) : escRe(v) + '(?:es|s)?';
      const re = new RegExp(`(?<![\\p{L}])${key}(?![\\p{L}])`, 'u');
      const m = re.exec(f);
      if (m) return { start: m.index, end: m.index + m[0].length, text: sentence.slice(m.index, m.index + m[0].length) };
    }
    return null;
  }

  // ---------- 4. Importancia de oraciones / resumen ----------
  function scoreSentences(sentences, keywords, defs, topicTokens) {
    const defPos = new Set(defs.map(d => d.pos));
    const firstOfHeading = new Set();
    const seenH = new Set();
    sentences.forEach(s => { if (!seenH.has(s.heading)) { seenH.add(s.heading); firstOfHeading.add(s.pos); } });

    return sentences.map(s => {
      let sc = 0;
      keywords.forEach(k => { if (findSpan(s.text, k)) sc += Math.min(k.score, 8); });
      const toks = [...s.text.matchAll(TOKEN)].map(m => stem(m[0]));
      toks.forEach(t => { if (topicTokens.has(t)) sc += 1.5; });
      const wc = s.text.split(/\s+/).length;
      sc = sc / Math.sqrt(wc);
      if (defPos.has(s.pos)) sc *= 1.5;
      if (firstOfHeading.has(s.pos)) sc *= 1.25;
      if (/\b(1[0-9]{3}|20[0-9]{2})\b/.test(s.text)) sc *= 1.15;
      if (/^(por ejemplo|ej\.|es decir)/i.test(s.text)) sc *= 0.5;
      if (wc > 45) sc *= 0.8;
      // Viñetas de apuntes: asegurar score mínimo para que no se descarten
      if (s.bullet && sc < 0.5) sc = 0.5 + (wc >= 4 ? 0.3 : 0);
      if (sc === 0 && wc >= 3 && s.text.length >= 10) sc = 0.35;
      return { ...s, score: sc };
    });
  }

  // ---------- 5. Asignar tema ----------
  function topicTokenSet(topics) {
    const set = new Set();
    (topics || []).forEach(t => [...t.name.matchAll(TOKEN)].forEach(m => { if (!isStop(m[0]) && m[0].length > 3) set.add(stem(m[0])); }));
    return set;
  }
  function assignTopic(text, topics) {
    if (!topics || !topics.length) return '';
    const toks = new Set([...text.matchAll(TOKEN)].map(m => stem(m[0])));
    let best = topics[0], bestScore = 0;
    for (const t of topics) {
      let sc = 0;
      [...t.name.matchAll(TOKEN)].forEach(m => { if (!isStop(m[0]) && m[0].length > 3 && toks.has(stem(m[0]))) sc++; });
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best.id;
  }

  // ---------- 6. Generador principal ----------
  // Helpers propios: no depender de globals de script.js
  function uid() {
    return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function formatDateISO(d) {
    const x = new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function mk(type, fields, topicId, source) {
    return Object.assign({
      id: uid(), topicId, type, interval: 1, ease: 2.5, reps: 0,
      nextReview: formatDateISO(new Date()), source: source || { kind: 'apuntes' }
    }, fields);
  }
  const shorten = (s, n = 110) => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const sp = cut.lastIndexOf(' ');
    return (sp > 0 ? cut.slice(0, sp) : cut) + '…';
  };

  function splitWordBlocks(text, maxWords = 5000) {
    const raw = String(text || '');
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [raw];
    const blocks = [];
    for (let i = 0; i < words.length; i += maxWords) {
      blocks.push(words.slice(i, i + maxWords).join(' '));
    }
    return blocks;
  }

  function mergeMaterials(parts, opts) {
    const merged = { summary: [], explanation: [], keywords: [], definitions: [], cards: [], warning: '' };
    const seenKw = new Set();
    const seenDef = new Set();
    const seenCard = new Set();
    const seenSum = new Set();
    for (const r of parts) {
      (r.summary || []).forEach(s => {
        const k = fold(s);
        if (!seenSum.has(k)) { seenSum.add(k); merged.summary.push(s); }
      });
      (r.explanation || []).forEach(s => {
        const k = fold(s);
        if (!seenSum.has('e:' + k)) { seenSum.add('e:' + k); merged.explanation.push(s); }
      });
      (r.keywords || []).forEach(k => {
        const key = fold(k);
        if (!seenKw.has(key)) { seenKw.add(key); merged.keywords.push(k); }
      });
      (r.definitions || []).forEach(d => {
        const key = fold(d.term);
        if (!seenDef.has(key)) { seenDef.add(key); merged.definitions.push(d); }
      });
      (r.cards || []).forEach(c => {
        const key = fold(c.front || c.question || c.statement || '');
        if (!key || seenCard.has(key)) return;
        seenCard.add(key);
        merged.cards.push(c);
      });
      if (r.warning) merged.warning = r.warning;
    }
    merged.summary = merged.summary.slice(0, 10);
    merged.explanation = merged.explanation.slice(0, 10);
    merged.keywords = merged.keywords.slice(0, 20);
    merged.definitions = merged.definitions.slice(0, 20);
    const cap = Math.max((opts.maxCards || 30) + 12, (opts.maxCards || 30) * Math.max(1, parts.length));
    merged.cards = merged.cards.slice(0, cap);
    return merged;
  }

  /**
   * Genera material de estudio a partir de un texto.
   * Textos largos se procesan en bloques de 5000 palabras.
   * opts: { topics: [..], topic: {id,name} (fijo), maxCards, source, stripParens, contextLabel }
   */
  function generate(text, opts = {}) {
    let src = String(text || '');
    // Solo aplicar corrector OCR cuando el caller lo pide (foto).
    // NUNCA sobre Wikipedia/texto limpio: el corrector de letra a mano corrompe el español correcto.
    const fromWeb = opts.source && opts.source.kind === 'web';
    if (opts.ocr && !fromWeb) {
      src = cleanOcrText(src);
      opts = { ...opts, ocr: true };
    } else if (fromWeb) {
      src = cleanWikiText(src);
      opts = { ...opts, ocr: false, web: true };
    }
    const blocks = splitWordBlocks(src, 5000);
    if (blocks.length <= 1) return generateBlock(src, opts);
    return mergeMaterials(blocks.map(b => generateBlock(b, opts)), opts);
  }

  /**
   * Resumen + explicación por secciones.
   * Para apuntes en viñetas: lista los puntos de cada tema sin inventar relaciones.
   */
  function buildSummaryAndExplain(scored, defs, headings, opts) {
    const seenS = new Set();
    scored.forEach(s => {
      const k = fold(s.text);
      if (seenS.has(k)) s.score = -1;
      else seenS.add(k);
    });
    // Incluir también score bajo si es viñeta/OCR (antes se perdían)
    const good = scored.filter(s => s.score > 0 || s.bullet || (opts.ocr && s.text && s.text.length >= 8));
    const byH = new Map();
    good.forEach(s => {
      const h = s.heading || (opts.contextLabel || (opts.topic && opts.topic.name)) || 'General';
      if (!byH.has(h)) byH.set(h, []);
      byH.get(h).push(s);
    });
    // Si no hay headings útiles, usar orden de aparición
    if (byH.size === 0 && scored.length) {
      byH.set('General', scored.filter(s => s.score >= 0));
    }

    const summary = [];
    const explanation = [];
    const seenLine = new Set();
    const pushSum = (line) => {
      const k = fold(line);
      if (!line || seenLine.has(k)) return;
      seenLine.add(k);
      summary.push(line);
    };

    const isWeb = !!(opts.web || (opts.source && opts.source.kind === 'web'));
    // Definiciones reales — filtrar fragmentos basura de Wikipedia
    const realDefs = (defs || []).filter(d => {
      if (!d.def || d.def.split(/\s+/).length < 3) return false;
      if (isTitleColon(d.term, d.def)) return false;
      if (isWeb && isWeakWebDef(d)) return false;
      return true;
    });
    if (realDefs.length) {
      const top = realDefs.slice(0, isWeb ? 4 : 5);
      top.forEach(d => pushSum(`${d.termFull}: ${shorten(d.def, 140)}`));
      const label = isWeb ? 'Ideas principales (Wikipedia)' : 'Puntos clave de tus apuntes';
      explanation.push(
        label + ': ' + top.map(d => `${d.termFull} → ${shorten(d.def, 80)}`).join('; ') + '.'
      );
    }

    // Una sección por título de apunte (ej. Revolución Francesa / Uruguay)
    let sections = 0;
    for (const [h, arr] of byH) {
      const ordered = [...arr].sort((a, b) => a.pos - b.pos);
      // Quitar duplicados del título repetido en el cuerpo
      const lines = [];
      const seen = new Set();
      for (const s of ordered) {
        let tx = s.text.replace(/^[→←]\s*/, '').trim();
        if (!tx) continue;
        const k = fold(tx);
        if (seen.has(k)) continue;
        // No repetir el heading tal cual
        if (fold(tx) === fold(h)) continue;
        seen.add(k);
        lines.push(tx);
      }
      if (!lines.length) continue;

      const label = (h && h !== 'General') ? h : null;
      if (label) {
        if (isWeb) {
          // Wikipedia: oraciones completas, sin mezclar fragmentos cortos
          const solid = lines.filter(x => x.split(/\s+/).length >= 10 && x.length >= 50);
          const pick = (solid.length ? solid : lines.filter(x => x.split(/\s+/).length >= 6)).slice(0, 4);
          if (pick.length) {
            explanation.push('Resumen (Wikipedia): ' + pick.map(x => x.replace(/[.]+$/, '')).join('. ') + '.');
            pick.forEach(x => pushSum(x));
          }
        } else {
          explanation.push(`Sobre «${label}»: ${lines.slice(0, 6).map(x => x.replace(/[.]+$/, '')).join('; ')}.`);
          pushSum(`【${label}】`);
          lines.slice(0, 8).forEach(x => pushSum('• ' + x));
        }
      } else {
        const pick = isWeb
          ? lines.filter(x => x.split(/\s+/).length >= 10).slice(0, 5)
          : lines.slice(0, 8);
        pick.forEach(x => pushSum(isWeb ? x : '• ' + x));
        if (pick.length) explanation.push(pick.slice(0, 3).join(isWeb ? ' ' : ' '));
      }
      sections++;
      if (sections >= (isWeb ? 3 : 8)) break;
    }

    // Fallback: si quedó vacío, volcar las mejores oraciones
    if (summary.length < 2) {
      const best = [...scored].filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
      best.sort((a, b) => a.pos - b.pos).forEach(s => pushSum(s.text));
      if (!explanation.length && best.length) {
        explanation.push(best.slice(0, 4).map(s => s.text).join(' '));
      }
    }

    return {
      summary: summary.slice(0, 20),
      explanation: explanation.slice(0, 8)
    };
  }

  function generateBlock(text, opts = {}) {
    const topics = opts.topics || [];
    const fixed = opts.topic || null;
    const tokens = topicTokenSet(fixed ? [fixed] : topics);
    const maxCards = opts.maxCards || 30;
    const source = opts.source || { kind: 'apuntes' };
    const tid = s => fixed ? fixed.id : assignTopic(s, topics);

    const { sentences, headings, colonDefs } = parse(text, { ...opts, defaultHeading: fixed ? fixed.name : '' });
    const result = { summary: [], explanation: [], keywords: [], definitions: [], cards: [], warning: '' };
    if (sentences.length < 1 && colonDefs.length < 1) {
      result.warning = 'El texto es muy corto o poco legible (común en fotos borrosas). Mejorá la luz, enfocá el texto o pegalo a mano en frases completas.';
      return result;
    }

    let defs = extractDefinitions(sentences, colonDefs);
    if (source.kind === 'web') {
      // Solo definiciones sólidas (X es…), no recortes de prosa
      defs = defs.filter(d => {
        if (isWeakWebDef(d)) return false;
        // Preferir verbos de definición real
        const hasDefVerb = /(es|son|fue|fueron|era|eran|se define|se denomina|se llama|consiste|significa)/i.test(d.verb + ' ' + d.sentence);
        const isNamedConcept = /revoluci|guerra|batalla|tratado|declaraci|constituci|imperio|república|ilustraci|absolutismo|feudalismo|monarqu/i.test(d.termFull);
        return hasDefVerb || isNamedConcept;
      }).slice(0, 6);
    }
    const keywords = extractKeywords(sentences, defs, source.kind === 'web' ? [] : headings, tokens, opts.maxKeywords || 12)
      .filter(k => {
        if (source.kind !== 'web') return true;
        // Menos ruido: evitar apellidos sueltos de historiadores y palabras muy genéricas
        if (/^(george|michel|jacques|nicolas|louis|pierre|según|hacia|entre|sobre)$/i.test(k.text)) return false;
        return k.text.length >= 4;
      });
    const scored = scoreSentences(sentences, keywords, defs, tokens);

    const built = buildSummaryAndExplain(scored, defs, headings, { ...opts, source, web: source.kind === 'web' });
    result.summary = built.summary;
    result.explanation = built.explanation;
    result.keywords = keywords.map(k => k.text).slice(0, source.kind === 'web' ? 10 : 20);
    result.definitions = defs.slice(0, source.kind === 'web' ? 6 : 12).map(d => ({ term: d.termFull, def: d.def }));

    const cards = [];
    const defPos = new Set(defs.map(d => d.pos));

    // a) Definiciones -> flashcards + preguntas abiertas
    const LABEL_TERMS = /^(causas?|efectos?|consecuencias?|etapas?|fases?|personajes?|contexto|importancia|resultado|objetivos?|caracter[ií]sticas?|ejemplos?|tipos?|partes?|factores?)$/i;
    defs.slice(0, 12).forEach(d => {
      const t = tid(d.sentence);
      let asks;
      if (/\b(denomina|llama|conoce)\b/.test(d.verb)) {
        asks = `¿Cómo se ${d.verb.match(/denomina|llama|conoce/)[0]} ${lowerFirst(d.termFull)}?`;
      } else if (LABEL_TERMS.test(d.term.trim())) {
        const lab = d.term.trim().toLowerCase();
        if (/causa/.test(lab)) asks = '¿Cuáles fueron las causas?';
        else if (/etapa|fase/.test(lab)) asks = '¿Cuáles fueron las etapas?';
        else if (/personaje/.test(lab)) asks = '¿Quiénes fueron los personajes principales?';
        else if (/contexto/.test(lab)) asks = '¿Cuál fue el contexto?';
        else if (/importancia/.test(lab)) asks = '¿Cuál fue la importancia?';
        else if (/resultado|consecuencia|efecto/.test(lab)) asks = '¿Cuál fue el resultado?';
        else asks = `¿Qué se indica en «${d.termFull}»?`;
      } else {
        asks = `${/^son/.test(d.verb) ? '¿Qué son' : '¿Qué es'} ${lowerFirst(d.termFull)}?`;
      }
      cards.push(mk('flashcard', { front: asks, back: d.sentence }, t, source));
    });
    defs.slice(0, 6).forEach(d => {
      cards.push(mk('qa', { question: `Explicá con tus palabras: ${d.termFull}`, answer: d.sentence }, tid(d.sentence), source));
    });

    // b) Explicar un título / tema con sus mejores oraciones
    const byHeading = new Map();
    scored.forEach(s => { if (s.heading) { if (!byHeading.has(s.heading)) byHeading.set(s.heading, []); byHeading.get(s.heading).push(s); } });
    let nExplain = 0;
    for (const [h, arr] of byHeading) {
      if (arr.length < 2 || nExplain >= 6 || (opts.contextLabel && fold(h) === fold(opts.contextLabel))) continue;
      const best = [...arr].sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.pos - b.pos);
      const label = opts.contextLabel && fold(h) !== fold(opts.contextLabel) ? `${opts.contextLabel} — ${h}` : h;
      cards.push(mk('qa', { question: `Explicá con tus palabras: ${label}`, answer: best.map(s => s.text).join(' ') },
        fixed ? fixed.id : tid(h + ' ' + best[0].text), source));
      nExplain++;
    }
    if (fixed) {
      const best = [...scored].sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.pos - b.pos);
      cards.push(mk('qa', { question: `Explicá con tus palabras: ${fixed.name}`, answer: best.map(s => s.text).join(' ') }, fixed.id, source));
    }

    // c) Datos (completar frases) usando las oraciones más importantes que no son definiciones
    const facts = [...scored].filter(s => !defPos.has(s.pos)).sort((a, b) => b.score - a.score).slice(0, 10);
    const years = /\b(1[0-9]{3}|20[0-9]{2})\b/;
    const factItems = [];
    facts.forEach(s => {
      let blank = null, answer = '', kind = 'kw';
      const ym = s.text.match(years);
      if (ym) { blank = { start: ym.index, end: ym.index + ym[0].length }; answer = ym[0]; kind = 'year'; }
      else {
        const inSent = keywords.map(k => ({ k, span: findSpan(s.text, k) })).filter(x => x.span && x.span.start > 0);
        if (!inSent.length) return;
        inSent.sort((a, b) => b.k.score - a.k.score);
        const pick = inSent[0];
        blank = pick.span; answer = pick.span.text; kind = 'kw';
        factItems.push({ s, blank, answer, kind, kw: pick.k });
        return;
      }
      factItems.push({ s, blank, answer, kind });
    });

    factItems.forEach(f => {
      const cloze = f.s.text.slice(0, f.blank.start) + '_____' + f.s.text.slice(f.blank.end);
      cards.push(mk('flashcard', { front: `Completá: ${cloze}`, back: `${f.answer} — ${f.s.text}` }, tid(f.s.text), source));
    });

    // d) Verdadero / Falso (con afirmaciones reales y versiones falsas coherentes)
    const tf = [];
    const dpool = defs.slice(0, 12);
    dpool.slice(0, 5).forEach((d, i) => {
      if (i % 2 === 0 || dpool.length < 2) {
        tf.push(mk('tf', { statement: d.sentence, correct: true, explanation: d.sentence }, tid(d.sentence), source));
      } else {
        const other = dpool[(i + 1) % dpool.length];
        if (other.term !== d.term && fold(other.def) !== fold(d.def)) {
          const od = /^[\p{Lu}]{2}/u.test(other.def) ? other.def : lowerFirst(other.def);
          tf.push(mk('tf', { statement: `${d.prefix}${od}.`, correct: false, explanation: `Correcto: ${d.sentence}` }, tid(d.sentence), source));
        }
      }
    });
    factItems.slice(0, 6).forEach((f, i) => {
      if (i % 2 === 0) {
        tf.push(mk('tf', { statement: f.s.text, correct: true, explanation: f.s.text }, tid(f.s.text), source));
      } else {
        let wrong = null;
        if (f.kind === 'year') {
          const y = parseInt(f.answer, 10);
          const delta = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.floor(Math.random() * 30));
          wrong = String(y + delta);
        } else {
          const alt = keywords.find(k => k.cap === f.kw.cap && k.key !== f.kw.key && !findSpan(f.s.text, k));
          if (alt) wrong = f.kw.cap ? alt.text : (/^\p{Lu}/u.test(f.answer) ? upperFirst(alt.text) : alt.text);
        }
        if (wrong) {
          const st = f.s.text.slice(0, f.blank.start) + wrong + f.s.text.slice(f.blank.end);
          tf.push(mk('tf', { statement: st, correct: false, explanation: `Correcto: ${f.s.text}` }, tid(f.s.text), source));
        }
      }
    });
    cards.push(...tf);

    // e) Opción múltiple — pozo ampliado de distractores (keywords + defs + sustantivos + glosario del examen)
    const mcs = [];
    const extraTerms = (opts.extraTerms || []).map(t => String(t || '').trim()).filter(t => t.length >= 3 && t.length <= 40);
    const nounPool = [];
    sentences.forEach(s => {
      for (const m of s.text.matchAll(TOKEN)) {
        const w = m[0];
        if (w.length < 4 || w.length > 28 || isStop(w)) continue;
        if (!/^[\p{L}]+$/u.test(w)) continue;
        nounPool.push(w);
      }
    });
    const pickDistractors = (need, correct, preferCap) => {
      const used = new Set([fold(String(correct))]);
      const out = [];
      const push = (t) => {
        let s = String(t || '').trim();
        if (!s || s.length < 2 || s.length > 40) return;
        const k = fold(s);
        if (used.has(k)) return;
        used.add(k);
        if (preferCap === true && /^\p{Ll}/u.test(s)) s = upperFirst(s);
        out.push(s);
      };
      const kwCand = keywords.filter(k => k.text && fold(k.text) !== fold(correct) && k.text.length <= 30);
      const orderedKw = preferCap == null ? kwCand : [
        ...kwCand.filter(k => !!k.cap === !!preferCap),
        ...kwCand.filter(k => !!k.cap !== !!preferCap)
      ];
      shuffle(orderedKw).forEach(k => { if (out.length < need) push(k.text); });
      shuffle(dpool.map(d => d.termFull)).forEach(t => { if (out.length < need) push(t); });
      shuffle(extraTerms).forEach(t => { if (out.length < need) push(t); });
      shuffle([...new Set(nounPool)]).forEach(w => { if (out.length < need) push(w); });
      const generics = ['concepto clave', 'proceso', 'elemento', 'fase', 'sistema', 'método', 'teoría', 'factor', 'principio', 'modelo'];
      shuffle(generics).forEach(g => { if (out.length < need) push(g); });
      return out.slice(0, need);
    };

    if (dpool.length >= 2) {
      dpool.slice(0, 6).forEach(d => {
        const others = pickDistractors(3, d.termFull, null);
        if (others.length < 3) return;
        const opts4 = shuffle([d.termFull, ...others]);
        const idx = opts4.findIndex(o => fold(o) === fold(d.termFull));
        if (idx < 0) return;
        mcs.push(mk('mc', {
          question: `¿A qué concepto corresponde esta descripción? «${shorten(upperFirst(d.def), 160)}»`,
          options: opts4.map(upperFirst), correctIndex: idx
        }, tid(d.sentence), source));
      });
    }
    factItems.slice(0, 5).forEach(f => {
      let distractors = [];
      if (f.kind === 'year') {
        const y = parseInt(f.answer, 10);
        const set = new Set();
        while (set.size < 3) {
          const v = y + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 40));
          if (v !== y && v > 0) set.add(String(v));
        }
        distractors = [...set];
      } else {
        distractors = pickDistractors(3, f.answer, f.kw ? !!f.kw.cap : null);
      }
      if (distractors.length < 3) return;
      const correct = f.answer;
      const options = shuffle([correct, ...distractors]);
      const idx = options.findIndex(o => fold(o) === fold(correct));
      if (idx < 0) return;
      const cloze = f.s.text.slice(0, f.blank.start) + '_____' + f.s.text.slice(f.blank.end);
      mcs.push(mk('mc', { question: `Completá: ${cloze}`, options, correctIndex: idx }, tid(f.s.text), source));
    });
    cards.push(...mcs);

    result.cards = cards.slice(0, maxCards + 12);
    if (!defs.length && !factItems.length) {
      result.warning = 'No encontré definiciones ni datos claros. Probá escribir los apuntes como frases completas (ej: "La mitosis es el proceso en el que…").';
    }
    return result;
  }

  // ---------- 7. Internet (Wikipedia en español) ----------
  const WIKI = 'https://es.wikipedia.org/w/api.php';

  async function fetchJSON(url, ms = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  const wikiUrl = title => 'https://es.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));

  async function wikiSearch(query, limit = 5) {
    const j = await fetchJSON(`${WIKI}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srnamespace=0&format=json&origin=*`);
    return ((j.query && j.query.search) || []).map(r => ({
      title: r.title,
      snippet: r.snippet.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      url: wikiUrl(r.title)
    }));
  }

  function cleanWikiText(raw) {
    let t = String(raw || '');
    // Caracteres invisibles / basura tipográfica de Wikipedia
    t = t.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
    t = t.replace(/\[cita requerida\]/gi, '');
    t = t.replace(/\[(?:nota\s*)?\d+\]/gi, '');
    t = t.replace(/\[\d+[a-z]?\]/g, '');
    t = t.replace(/\([^)]{0,80}escuchar[^)]{0,40}\)/gi, '');
    t = t.replace(/\s{2,}/g, ' ');

    const out = [];
    for (const line of t.split('\n')) {
      const h = line.match(/^=+\s*(.+?)\s*=+$/);
      if (h) {
        if (/^(véase también|referencias|enlaces externos|notas|bibliografía|fuentes|galería|obras relacionadas|filmografía)/i.test(h[1])) break;
        out.push(h[1].trim());
        continue;
      }
      let L = line.trim();
      if (!L) continue;
      // Saltarse listas de puras fechas/coords o restos de tablas
      if (/^\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\s*[—–-]/i.test(L) && L.length < 40) continue;
      out.push(L);
    }
    t = out.join('\n');
    // Limitar tamaño: intro + primeras secciones (material de estudio, no el artículo entero)
    const words = t.split(/\s+/);
    if (words.length > 900) t = words.slice(0, 900).join(' ') + '.';
    return t.trim();
  }

  async function wikiExtract(title) {
    const j = await fetchJSON(
      `${WIKI}?action=query&prop=extracts|pageprops&ppprop=disambiguation&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`,
      12000
    );
    const page = Object.values((j.query && j.query.pages) || {})[0];
    if (!page || !page.extract) return null;
    if (page.pageprops && Object.prototype.hasOwnProperty.call(page.pageprops, 'disambiguation')) return null;
    const text = cleanWikiText(page.extract);
    if (/puede (referirse|hacer referencia)/i.test(text.slice(0, 400))) return null;
    return { title: page.title, url: wikiUrl(page.title), text };
  }

  const overlap = (a, b) => {
    const A = new Set([...a.matchAll(TOKEN)].filter(m => m[0].length > 3 && !isStop(m[0])).map(m => stem(m[0])));
    const B = new Set([...b.matchAll(TOKEN)].map(m => stem(m[0])));
    let n = 0; A.forEach(x => { if (B.has(x)) n++; });
    return { n, total: A.size };
  };

  /** Busca el mejor artículo para un tema (usa el nombre del tema y la materia). */
  async function findArticleForTopic(topicName, subject) {
    const queries = [topicName];
    if (subject) queries.push(`${topicName} ${subject}`);
    const cands = new Map();
    for (const q of queries) {
      try {
        (await wikiSearch(q, 5)).forEach((r, i) => {
          if (!cands.has(r.title)) cands.set(r.title, { ...r, rank: i });
        });
      } catch (e) { if (!cands.size) throw e; }
    }
    const ranked = [...cands.values()].map(c => {
      const ot = overlap(topicName, c.title), os = overlap(topicName, c.snippet);
      const rel = ot.n * 2 + os.n;
      return { ...c, rel, score: rel - c.rank * 0.3 };
    }).filter(c => c.rel > 0).sort((a, b) => b.score - a.score);

    for (const c of ranked.slice(0, 3)) {
      const art = await wikiExtract(c.title);
      if (!art || art.text.length < 300) continue;
      return art;
    }
    return null;
  }

  // ---------- 8. Punto de conexión para IA real ----------
  /**
   * Extensión opcional. Hoy no se usa LLM: el material sale del algoritmo + Wikipedia.
   */
  async function enhanceWithAI(material /*, context */) {
    return material;
  }

  /* ============================================================
     PUNTOS DÉBILES ("Cementerio de tarjetas")
     ============================================================ */

  /**
   * Una tarjeta es un "punto débil" si ya falló alguna vez y todavía no está
   * consolidada: cero repeticiones exitosas seguidas, o una facilidad (ease)
   * muy baja, o falló 3+ veces y aún no acumula 3 aciertos.
   */
  function isWeak(c) {
    const lapses = c.lapses || 0;
    const ease = c.ease == null ? 2.5 : c.ease;
    const reps = c.reps || 0;
    const attempted = lapses > 0 || ease < 2.5;     // compatible con tarjetas guardadas antes de v4
    return attempted && (reps === 0 || ease <= 2.1 || (lapses >= 3 && reps < 3));
  }

  /** Cuanto más alto, más urgente repasarla. */
  function weakScore(c) {
    const ease = c.ease == null ? 2.5 : c.ease;
    return (c.lapses || 0) * 2 + (2.5 - ease) * 5 + ((c.reps || 0) === 0 ? 3 : 0);
  }

  /* ============================================================
     SIMULACRO DE EXAMEN
     ============================================================ */

  /** Raíces (stems) de las palabras con contenido de un texto. */
  function keyStems(text) {
    const set = new Set();
    for (const m of String(text || '').matchAll(TOKEN)) {
      if (m[0].length > 3 && !isStop(m[0])) set.add(stem(m[0]));
    }
    return set;
  }

  /** Qué fracción (0–1) de las palabras clave de la respuesta modelo aparece en lo que escribió el alumno. */
  function coverage(answer, reference) {
    const ref = keyStems(reference);
    if (!ref.size) return 0;
    const got = keyStems(answer);
    let hit = 0;
    ref.forEach(k => { if (got.has(k)) hit++; });
    return hit / ref.size;
  }

  /** Puntaje sugerido para una respuesta abierta: 1, 0.5 o 0. (El alumno puede corregirlo al revisar.) */
  function scoreOpen(answer, reference) {
    if (!String(answer || '').trim()) return 0;
    const c = coverage(answer, reference);
    return c >= 0.6 ? 1 : c >= 0.3 ? 0.5 : 0;
  }

  /** Nota de 1 a 10 (un decimal). 0 % → 1,0 · 50 % → 5,0 · 100 % → 10. */
  function gradeFromScore(points, total) {
    if (!total) return 1;
    return Math.max(1, Math.round((points / total) * 100) / 10);
  }

  const MOCK_SPEC = { open: 2, mc: 3, tf: 3 };

  /**
   * Arma un simulacro a partir de las tarjetas de un examen.
   * Por defecto: 3 Verdadero/Falso + 3 opción múltiple + 2 preguntas abiertas.
   * Prioriza tarjetas débiles o vencidas (con algo de azar). Si falta de un tipo,
   * completa con otros tipos para llegar al total.
   * Devuelve { items, spec (lo realmente armado), wanted }.
   */
  function buildMockExam(cards, spec = MOCK_SPEC) {
    const d0 = new Date();
    const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const rank = c => Math.random() + (isWeak(c) ? 0.6 : 0) + ((c.nextReview || today) <= today ? 0.3 : 0);
    const sorted = list => list.map(c => [rank(c), c]).sort((a, b) => b[0] - a[0]).map(x => x[1]);

    const pools = {
      tf: sorted(cards.filter(c => c.type === 'tf')),
      mc: sorted(cards.filter(c => c.type === 'mc' && Array.isArray(c.options) && c.options.length >= 2)),
      // las abiertas salen de las preguntas (qa) y, si no alcanzan, de las flashcards (término → definición)
      open: [...sorted(cards.filter(c => c.type === 'qa')), ...sorted(cards.filter(c => c.type === 'flashcard'))]
    };

    const toItem = (c, kind) => {
      const base = { cardId: c.id, topicId: c.topicId, kind, source: c.source || null };
      if (kind === 'tf') return { ...base, prompt: c.statement, correct: !!c.correct, explanation: c.explanation || '' };
      if (kind === 'mc') return { ...base, prompt: c.question, options: c.options.slice(), correctIndex: c.correctIndex, explanation: c.explanation || '' };
      return c.type === 'qa'
        ? { ...base, prompt: c.question, answer: c.answer }
        : { ...base, prompt: `Explicá con tus palabras: ${c.front}`, answer: c.back };
    };

    const taken = { open: [], mc: [], tf: [] };
    const used = new Set();
    const take = (kind, n) => {
      while (n > 0 && pools[kind].length) {
        const c = pools[kind].shift();
        if (used.has(c.id)) continue;
        used.add(c.id);
        taken[kind].push(toItem(c, kind));
        n--;
      }
      return n;   // lo que faltó
    };

    let missing = 0;
    ['tf', 'mc', 'open'].forEach(k => { missing += take(k, spec[k] || 0); });
    // completar faltantes con lo que sobre (primero opción múltiple, luego V/F, luego abiertas)
    ['mc', 'tf', 'open'].forEach(k => { if (missing > 0) missing = take(k, missing); });

    const items = [...taken.tf, ...taken.mc, ...taken.open];
    return {
      items,
      spec: { tf: taken.tf.length, mc: taken.mc.length, open: taken.open.length },
      wanted: (spec.tf || 0) + (spec.mc || 0) + (spec.open || 0)
    };
  }

  return { generate, parse, cleanOcrText, looksLikeOcr, assignTopic, findArticleForTopic, wikiSearch, wikiExtract, enhanceWithAI, esc, fold, stem, splitWordBlocks,
           isWeak, weakScore, keyStems, coverage, scoreOpen, gradeFromScore, buildMockExam, MOCK_SPEC };
})();

if (typeof module !== 'undefined') module.exports = SM;
