/* 错题本 Web App
 * 数据层：默认 localStorage（保留图片 dataURL），抽象为 Store 接口。
 * 云同步：CloudAdapter 预留，未来开通 WorkBuddy 云服务后接入即可无缝切换。
 */
(function () {
  'use strict';

  var SUBJECTS = ['语文','数学','英语','物理','化学','生物','政治','历史','地理'];
  var ERROR_TYPES = ['概念不清','计算失误','审题偏差','粗心马虎','方法不会'];
  var MASTERY = { unmastered:'未掌握', reviewing:'巩固中', mastered:'已掌握' };
  var STORAGE_KEY = 'cuoti-web-v1';
  var OCR_KEY_STORAGE = 'cuoti-ocrspace-key';   // 用户自填的云端OCR key（仅存本机）
  var OCR_CONSENT_STORAGE = 'cuoti-cloud-ocr-consent';
  var OCRSPACE_DEFAULT_KEY = 'helloworld';     // 官方公共测试key（有速率限制，仅测试用）
  var BANK_URL = 'questions.json';             // 公共题库（只读，不含学生数据）

  /* ============ 数据层 ============ */
  var Store = {
    _read: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },
    _write: function (items) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); return true; }
      catch (e) { App.toast('存储空间不足，请删除部分带图错题'); return false; }
    },
    list: function () { return this._read().sort(function(a,b){ return (b.updatedAt||0)-(a.updatedAt||0); }); },
    get: function (id) {
      var all = this._read();
      for (var i=0;i<all.length;i++){ if (String(all[i].id)===String(id)) return all[i]; }
      return null;
    },
    create: function (data) {
      var items = this._read();
      var now = Date.now();
      data.id = String(now) + '-' + Math.floor(Math.random()*10000);
      data.createdAt = now; data.updatedAt = now;
      items.unshift(data);
      this._write(items); return data;
    },
    update: function (id, patch) {
      var items = this._read();
      for (var i=0;i<items.length;i++){
        if (String(items[i].id)===String(id)) {
          items[i] = Object.assign({}, items[i], patch, {updatedAt:Date.now()});
          this._write(items); return items[i];
        }
      }
      return null;
    },
    remove: function (id) {
      var items = this._read().filter(function(x){ return String(x.id)!==String(id); });
      this._write(items);
    },
    replaceAll: function (items) { this._write(items); },
    count: function () { return this._read().length; }
  };

  /* 云同步适配器（预留）：开通云服务后，把 Store 的方法替换为 cloud.database 调用即可。
     页面层只调用 Store.list/create/update/remove，不感知底层是本地还是云。 */
  var CloudAdapter = {
    enabled: false,
    cloud: null,
    init: function (publicConfig) {
      /* if (window.WorkBuddyCloud) {
        this.cloud = WorkBuddyCloud.createWorkBuddyCloud({
          endpoint: publicConfig.endpoint,
          oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
          publishableKey: publicConfig.publishableKey
        });
        this.enabled = true;
      } */
    }
  };

  /* ============ 应用 ============ */
  var App = {
    editingId: '',
    currentImage: '',
    ocrWorker: null,
    quizQueue: [], quizIndex: 0, quizShowAnswer: false, quizResult:{mastered:0,again:0},

    init: function () {
      this.fillSelect('f-subject', SUBJECTS, '全部学科');
      this.fillSelect('f-subject2', SUBJECTS);
      this.fillSelect('f-error', ERROR_TYPES, '全部错因');
      this.fillSelect('f-errtype', ERROR_TYPES);
      this.fillSelect('bank-subject', SUBJECTS, '全部学科');
      var savedKey = localStorage.getItem(OCR_KEY_STORAGE) || '';
      var keyInput = document.getElementById('ocr-key');
      if (keyInput) keyInput.value = savedKey;
      this.renderList();
      this.loadBank();
      this.loadFromQuery();
    },

    fillSelect: function (id, options, allLabel) {
      var el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = '';
      if (allLabel) {
        var o0 = document.createElement('option'); o0.value=''; o0.textContent=allLabel; el.appendChild(o0);
      }
      options.forEach(function (op) {
        var o = document.createElement('option');
        o.value = op; o.textContent = op; el.appendChild(o);
      });
    },

    go: function (page) {
      var pages = ['home','add','review','stats','bank'];
      pages.forEach(function(p){ var el=document.getElementById('page-'+p); if(el) el.classList.toggle('on', p===page); });
      ['home','add','review','stats'].forEach(function(p){ var el=document.getElementById('tab-'+p); if(el) el.classList.toggle('on', p===page); });
      window.scrollTo(0,0);
      if (page==='home') this.renderList();
      if (page==='stats') this.renderStats();
      if (page==='review') this.renderReview();
      if (page==='bank') this.renderBank();
      if (page==='add' && !this.editingId) this.resetForm();
    },

    toast: function (msg) {
      var t = document.getElementById('toast');
      t.textContent = msg; t.classList.remove('hidden');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function(){ t.classList.add('hidden'); }, 2200);
    },

    /* ---------- 列表 ---------- */
    renderList: function () {
      var keyword = (document.getElementById('f-keyword')||{}).value || '';
      var subject = (document.getElementById('f-subject')||{}).value || '';
      var error = (document.getElementById('f-error')||{}).value || '';
      keyword = keyword.trim().toLowerCase();

      var items = Store.list().filter(function(it){
        if (subject && it.subject!==subject) return false;
        if (error && it.errorType!==error) return false;
        if (keyword) {
          var hay = [it.questionText,it.myAnswer,it.correctAnswer].concat(it.knowledgePoints||[]).join(' ').toLowerCase();
          if (hay.indexOf(keyword)===-1) return false;
        }
        return true;
      });

      var area = document.getElementById('list-area');
      if (items.length===0) {
        area.innerHTML = '<div class="state"><div class="big">○</div><h3>还没有错题</h3><p>点击上方「录入错题」，拍下第一道题</p></div>';
        return;
      }
      var html = items.map(function(it){
        var tags = (it.knowledgePoints||[]).slice(0,3).join(' · ') || '暂无知识点标签';
        var q = it.questionText || '（见题目照片）';
        var qShow = q.length>90 ? q.slice(0,90)+'…' : q;
        var mKey = it.mastery || 'unmastered';
        var mClass = mKey==='mastered'?'b-mastered':(mKey==='reviewing'?'b-reviewing':'b-unmastered');
        var d = new Date(it.updatedAt||Date.now());
        var time = (d.getMonth()+1)+'-'+d.getDate();
        var img = it.imagePath ? '<img class="thumb" src="'+it.imagePath+'" onclick="event.stopPropagation();App.viewImage(\''+it.id+'\')">' : '';
        return '<div class="card" onclick="App.edit(\''+it.id+'\')">'+
          '<div class="card-head">'+
            '<span class="badge b-subject">'+esc(it.subject||'未分类')+'</span>'+
            '<span class="badge b-error">'+esc(it.errorType||'未标注')+'</span>'+
            '<span class="badge '+mClass+'">'+MASTERY[mKey]+'</span>'+
            '<span class="card-time">'+time+'</span>'+
          '</div>'+
          '<div class="card-body">'+img+'<div class="card-text">'+
            '<div class="qtext">'+esc(qShow)+'</div>'+
            '<div class="tags">'+esc(tags)+'</div>'+
          '</div></div>'+
          '<div class="card-foot"><span>已复习 '+(it.reviewCount||0)+' 次</span><span class="edit">点击编辑 ›</span></div>'+
        '</div>';
      }).join('');
      area.innerHTML = html;
    },

    viewImage: function (id) {
      var it = Store.get(id);
      if (it && it.imagePath) window.open(it.imagePath, '_blank');
    },

    /* ---------- 表单 ---------- */
    resetForm: function () {
      this.editingId = '';
      this.currentImage = '';
      document.getElementById('add-title').textContent = '录入错题';
      document.getElementById('f-question').value = '';
      document.getElementById('f-myanswer').value = '';
      document.getElementById('f-correct').value = '';
      document.getElementById('f-knowledge').value = '';
      document.getElementById('f-source').value = '';
      document.getElementById('f-subject2').value = SUBJECTS[0];
      document.getElementById('f-grade').value = '初一';
      document.getElementById('f-errtype').value = ERROR_TYPES[0];
      document.getElementById('f-diff').value = '基础';
      document.getElementById('f-mastery').value = 'unmastered';
      document.getElementById('mastery-field').classList.add('hidden');
      document.getElementById('preview').classList.add('hidden');
      document.getElementById('imgbox').classList.remove('hidden');
      document.getElementById('del-btn').classList.add('hidden');
      document.getElementById('ocr-status').textContent = '拍照后可自动识别文字';
      this.clearOCRReview();
    },

    clearOCRReview: function () {
      var r = document.getElementById('ocr-result');
      if (r) r.value = '';
      var rv = document.getElementById('ocr-review');
      if (rv) rv.classList.add('hidden');
      var cf = document.getElementById('ocr-conf');
      if (cf) cf.textContent = '';
    },

    edit: function (id) {
      var it = Store.get(id);
      if (!it) return;
      this.editingId = id;
      this.currentImage = it.imagePath || '';
      document.getElementById('add-title').textContent = '编辑错题';
      document.getElementById('f-question').value = it.questionText || '';
      document.getElementById('f-myanswer').value = it.myAnswer || '';
      document.getElementById('f-correct').value = it.correctAnswer || '';
      document.getElementById('f-knowledge').value = (it.knowledgePoints||[]).join('、');
      document.getElementById('f-source').value = it.source || '';
      document.getElementById('f-subject2').value = it.subject || SUBJECTS[0];
      document.getElementById('f-grade').value = it.grade || '初一';
      document.getElementById('f-errtype').value = it.errorType || ERROR_TYPES[0];
      document.getElementById('f-diff').value = it.difficulty || '基础';
      document.getElementById('f-mastery').value = it.mastery || 'unmastered';
      document.getElementById('mastery-field').classList.remove('hidden');
      document.getElementById('del-btn').classList.remove('hidden');
      if (this.currentImage) {
        document.getElementById('preview').src = this.currentImage;
        document.getElementById('preview').classList.remove('hidden');
        document.getElementById('imgbox').classList.add('hidden');
      } else {
        document.getElementById('preview').classList.add('hidden');
        document.getElementById('imgbox').classList.remove('hidden');
      }
      document.getElementById('ocr-status').textContent = '拍照后可自动识别文字';
      this.clearOCRReview();
      this.go('add');
    },

    onImage: function (event) {
      var file = event.target.files[0];
      if (!file) return;
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        self.currentImage = e.target.result;
        var p = document.getElementById('preview');
        p.src = self.currentImage; p.classList.remove('hidden');
        document.getElementById('imgbox').classList.add('hidden');
        self.clearOCRReview();
        self.toast('图片已就绪，可点 OCR 识别');
      };
      reader.readAsDataURL(file);
    },

    previewImg: function () {
      if (this.currentImage) window.open(this.currentImage, '_blank');
    },

    save: function () {
      var q = document.getElementById('f-question').value.trim();
      if (!q && !this.currentImage) { this.toast('请拍照或填写题干'); return; }
      var data = {
        imagePath: this.currentImage,
        questionText: q,
        subject: document.getElementById('f-subject2').value,
        grade: document.getElementById('f-grade').value,
        errorType: document.getElementById('f-errtype').value,
        difficulty: document.getElementById('f-diff').value,
        myAnswer: document.getElementById('f-myanswer').value.trim(),
        correctAnswer: document.getElementById('f-correct').value.trim(),
        knowledgePoints: document.getElementById('f-knowledge').value.split(/[、,，\s]+/).map(function(s){return s.trim();}).filter(Boolean),
        source: document.getElementById('f-source').value.trim()
      };
      if (this.editingId) {
        data.mastery = document.getElementById('f-mastery').value;
        Store.update(this.editingId, data);
        this.toast('已更新');
      } else {
        data.mastery = 'unmastered';
        Store.create(data);
        this.toast('已保存');
      }
      this.editingId = '';
      this.go('home');
    },

    del: function () {
      if (!this.editingId) return;
      var self = this;
      if (confirm('确认删除这道错题？删除后不可恢复。')) {
        Store.remove(this.editingId);
        self.editingId = '';
        self.toast('已删除');
        self.go('home');
      }
    },

    /* ---------- OCR 增强（预处理 → 双模式识别 → 后处理 → 校对） ---------- */

    // 图像预处理：转灰度 + Otsu 二值化 + 按需放大，提升印刷体/小字识别率
    preprocessForOCR: function (dataUrl) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var scale = w < 1400 ? Math.min(2.5, 1600 / w) : 1; // 小图放大到约1600px
            var cw = Math.round(w * scale), ch = Math.round(h * scale);
            var canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, cw, ch);
            var id = ctx.getImageData(0, 0, cw, ch), d = id.data;
            // 灰度
            var hist = new Uint32Array(256);
            var gray = new Uint8Array(cw * ch);
            for (var i = 0, p = 0; i < d.length; i += 4, p++) {
              var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
              gray[p] = g; hist[g]++;
            }
            // Otsu 求阈值
            var total = cw * ch, sum = 0, t;
            for (t = 0; t < 256; t++) sum += t * hist[t];
            var sumB = 0, wB = 0, maxV = -1, th = 128;
            for (t = 0; t < 256; t++) {
              wB += hist[t]; if (!wB) continue;
              var wF = total - wB; if (!wF) break;
              sumB += t * hist[t];
              var mB = sumB / wB, mF = (sum - sumB) / wF;
              var v = wB * wF * (mB - mF) * (mB - mF);
              if (v > maxV) { maxV = v; th = t; }
            }
            th = Math.max(60, Math.min(220, th)); // 防止过暗/过曝误判
            // 二值化（反锯齿文献用软阈值，这里硬阈值对印刷体更稳）
            for (var i2 = 0, p2 = 0; i2 < d.length; i2 += 4, p2++) {
              var b = gray[p2] < th ? 0 : 255;
              d[i2] = d[i2 + 1] = d[i2 + 2] = b; d[i2 + 3] = 255;
            }
            ctx.putImageData(id, 0, 0);
            resolve(canvas);
          } catch (e) { resolve(dataUrl); } // 预处理失败则回退原图
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      });
    },

    // 后处理校正：全角半角、中文断行合并、数学符号规范、杂讯清理
    postProcessOCR: function (text, mode) {
      var s = String(text || '');
      // 全角数字/字母 → 半角
      s = s.replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      s = s.replace(/[\uFF21-\uFF3A]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      s = s.replace(/[\uFF41-\uFF5A]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      // 全角运算符 → 规范符号（全角括号在中文题干保留，仅公式模式转半角）
      s = s.replace(/\uFF1D/g, '=').replace(/\uFF0B/g, '+').replace(/\uFF0D/g, '-')
           .replace(/\uFF0A/g, '×').replace(/\uFF0F/g, '/');
      // 数字×数字（OCR 常把乘号识别成字母 x/X）
      s = s.replace(/(\d)\s*[xX]\s*(\d)/g, '$1×$2');
      // 中文之间的多余空格
      s = s.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2');
      // 断行合并：行尾中文/中文标点 + 下行中文或左括号 → 合并（题干常见被拆行）
      var lines = s.split('\n');
      var merged = [];
      for (var i = 0; i < lines.length; i++) {
        var cur = lines[i].trim();
        if (!cur) {
          // 空行作为段落分隔，最多保留一个，且不在开头
          if (merged.length && merged[merged.length - 1] !== '') merged.push('');
          continue;
        }
        var prev = merged.length ? merged[merged.length - 1] : '';
        if (prev && /[\u4e00-\u9fa5，。；：、？！）]$/.test(prev) &&
            /^[（(\u4e00-\u9fa5]/.test(cur)) {
          merged[merged.length - 1] = prev + cur;
        } else { merged.push(cur); }
      }
      while (merged.length && merged[0] === '') merged.shift();
      while (merged.length && merged[merged.length - 1] === '') merged.pop();
      s = merged.join('\n');
      // 公式模式额外规范
      if (mode === 'formula') {
        s = s.replace(/\uFF08/g, '(').replace(/\uFF09/g, ')')
             .replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/<>/g, '≠');
      }
      return s;
    },

    runOCR: function (mode) {
      var self = this;
      if (!this.currentImage) { this.toast('请先拍照或选择图片'); return; }
      if (typeof Tesseract === 'undefined') { this.toast('OCR 组件未加载，请检查网络'); return; }
      mode = mode === 'formula' ? 'formula' : 'general';
      var btnG = document.getElementById('ocr-btn');
      var btnF = document.getElementById('ocr-formula-btn');
      var status = document.getElementById('ocr-status');
      var confEl = document.getElementById('ocr-conf');
      var review = document.getElementById('ocr-review');
      btnG.disabled = true; btnF.disabled = true;
      review.classList.add('hidden');
      confEl.textContent = '';
      status.textContent = '正在预处理图像（灰度/二值化/放大）…';

      var usePre = document.getElementById('ocr-preprocess').checked;
      var feed = usePre ? this.preprocessForOCR(this.currentImage) : Promise.resolve(this.currentImage);

      feed.then(function (imageInput) {
        if (!self.ocrWorker) {
          status.textContent = '首次使用需下载中英文识别包（约20MB）…';
          self.ocrWorker = Tesseract.createWorker('chi_sim+eng', 1, {
            logger: function (m) {
              if (m.status === 'recognizing text') {
                status.textContent = '识别中 ' + Math.round(m.progress * 100) + '%';
              } else if (m.status === 'loading language traineddata' || m.status === 'initializing tesseract') {
                status.textContent = '正在加载识别引擎…';
              }
            }
          });
        }
        return self.ocrWorker.then(function (worker) {
          // 版式：试卷题块用 PSM 6（统一文本块），通常比自动分栏更准
          try { worker.setParameters({ tessedit_pageseg_mode: '6' }); } catch (e) {}
          status.textContent = '正在识别…';
          return worker.recognize(imageInput);
        });
      }).then(function (res) {
        var raw = (res.data && res.data.text) || '';
        var text = self.postProcessOCR(raw, mode);
        var conf = res.data && res.data.confidence;
        if (text) {
          document.getElementById('ocr-result').value = text;
          review.classList.remove('hidden');
          if (typeof conf === 'number') {
            var lv = conf >= 75 ? '高' : (conf >= 50 ? '中' : '低');
            var color = conf >= 75 ? 'var(--green)' : (conf >= 50 ? 'var(--orange)' : 'var(--red)');
            confEl.innerHTML = '置信度 <b style="color:' + color + '">' + lv + ' ' + Math.round(conf) + '%</b>' +
              (conf < 75 ? ' · 请重点校对' : '');
          }
          status.textContent = '识别完成，请在下方校对后填入题干';
          self.toast('识别完成，请校对');
          try { document.getElementById('ocr-result').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        } else {
          status.textContent = '未识别到文字，请手动输入或改用另一张照片';
          self.toast('未识别到文字');
        }
        btnG.disabled = false; btnF.disabled = false;
      }).catch(function (err) {
        status.textContent = '识别失败，请手动输入';
        btnG.disabled = false; btnF.disabled = false;
        self.toast('OCR 识别失败');
        console.error(err);
      });
    },

    // 把校对区结果填入题干（replace）或追加（append）
    applyOCR: function (append) {
      var text = document.getElementById('ocr-result').value.trim();
      if (!text) { this.toast('校对区为空'); return; }
      var el = document.getElementById('f-question');
      el.value = append ? (el.value ? el.value.replace(/\s+$/, '') + '\n' + text : text) : text;
      this.toast(append ? '已追加到题干' : '已填入题干');
      try { el.focus(); } catch (e) {}
    },

    // 在校对区光标处插入数学符号
    insertSymbol: function (sym) {
      var el = document.getElementById('ocr-result');
      var s = el.selectionStart, e = el.selectionEnd;
      var v = el.value;
      el.value = v.slice(0, s) + sym + v.slice(e);
      var pos = s + sym.length;
      el.focus();
      try { el.setSelectionRange(pos, pos); } catch (err) {}
    },

    /* ---------- 云端 OCR（OCR.space，识别率更高，但照片会上传到第三方） ---------- */
    getOCRKey: function () {
      return (localStorage.getItem(OCR_KEY_STORAGE) || '').trim() || OCRSPACE_DEFAULT_KEY;
    },
    saveOCRKey: function () {
      var v = (document.getElementById('ocr-key').value || '').trim();
      if (v) {
        localStorage.setItem(OCR_KEY_STORAGE, v);
        this.toast('已保存 API Key（仅存本机）');
      } else {
        localStorage.removeItem(OCR_KEY_STORAGE);
        this.toast('已清除，恢复使用公共测试 key');
      }
    },

    runCloudOCR: function () {
      var self = this;
      if (!this.currentImage) { this.toast('请先选择照片'); return; }

      // 首次使用需知情同意（照片将上传到第三方服务器）
      var consented = localStorage.getItem(OCR_CONSENT_STORAGE) === '1';
      if (!consented) {
        var ok = confirm('云端识别说明\n\n· 题目照片将上传到第三方服务 OCR.space 进行识别\n· 识别完成后网页不会保存照片副本，但第三方会短暂处理该图片\n· 若不希望照片外传，请使用「本地识别」\n\n是否同意并继续？');
        if (!ok) return;
        localStorage.setItem(OCR_CONSENT_STORAGE, '1');
      }

      var btn = document.getElementById('ocr-cloud-btn');
      var status = document.getElementById('ocr-status');
      var confEl = document.getElementById('ocr-conf');
      var review = document.getElementById('ocr-review');
      btn.disabled = true; review.classList.add('hidden'); confEl.textContent = '';
      status.textContent = '正在上传并识别（云端）…';

      // dataURL → base64（OCR.space 接受带 data:image 前缀的 base64Image）
      var base64 = this.currentImage;
      var lang = (document.getElementById('ocr-lang') || {}).value || 'chs';
      var engine = (document.getElementById('ocr-engine') || {}).value || '2';
      var form = new FormData();
      form.append('apikey', this.getOCRKey());
      form.append('base64Image', base64);
      form.append('language', lang);
      form.append('isOverlayRequired', 'false');
      form.append('OCREngine', engine);
      form.append('scale', 'true');
      form.append('detectOrientation', 'true');

      fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (res) {
          if (res.IsErroredOnProcessing) {
            var em = (res.ErrorMessage && (Array.isArray(res.ErrorMessage) ? res.ErrorMessage.join('；') : res.ErrorMessage)) || '识别失败';
            throw new Error(em);
          }
          var results = res.ParsedResults || [];
          var raw = results.map(function (x) { return x.ParsedText || ''; }).join('\n');
          var text = self.postProcessOCR(raw, 'general').replace(/\n{2,}/g, '\n').trim();
          if (!text) { status.textContent = '未识别到文字，请换张更清晰的照片'; self.toast('未识别到文字'); return; }
          document.getElementById('ocr-result').value = text;
          review.classList.remove('hidden');
          confEl.innerHTML = '<b style="color:var(--green)">云端识别完成</b>' +
            (self.getOCRKey() === OCRSPACE_DEFAULT_KEY ? ' · 使用公共测试key（有速率限制）' : '');
          status.textContent = '识别完成，请在下方校对后填入题干';
          self.toast('云端识别完成，请校对');
          try { document.getElementById('ocr-result').scrollIntoView({ behavior:'smooth', block:'center' }); } catch (e) {}
        })
        .catch(function (err) {
          var msg = String(err && err.message || err);
          status.textContent = '云端识别失败：' + msg.slice(0, 40);
          self.toast('云端识别失败，可改用本地识别');
          console.error(err);
        })
        .then(function () { btn.disabled = false; });
    },

    /* ---------- 公共题库（GitHub 只读 JSON，不含学生数据） ---------- */
    loadBank: function () {
      var self = this;
      this.bankItems = [];
      var area = document.getElementById('bank-area');
      if (!area) return;
      area.innerHTML = '<div class="state"><div class="big">◌</div><h3>正在加载公共题库…</h3></div>';
      fetch(BANK_URL + '?t=' + Date.now())
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (data) {
          self.bankItems = Array.isArray(data.questions) ? data.questions : (Array.isArray(data) ? data : []);
          self.renderBank();
        })
        .catch(function (err) {
          area.innerHTML = '<div class="state"><div class="big">☁</div><h3>题库加载失败</h3><p>请检查网络后重试</p>' +
            '<button class="btn btn-ghost" style="margin-top:14px" onclick="App.loadBank()">重新加载</button></div>';
        });
    },

    renderBank: function () {
      var area = document.getElementById('bank-area');
      if (!area) return;
      var subject = (document.getElementById('bank-subject') || {}).value || '';
      var list = [];
      for (var i = 0; i < this.bankItems.length; i++) {
        if (!subject || this.bankItems[i].subject === subject) list.push({ idx: i, q: this.bankItems[i] });
      }
      if (!list.length) {
        area.innerHTML = '<div class="state"><div class="big">◌</div><h3>暂无题目</h3><p>换个学科试试</p></div>';
        return;
      }
      var html = '<div class="bank-note">公共题库为只读示例，可一键加入本机错题库；不含任何学生个人信息。</div>';
      html += list.map(function (row) {
        var q = row.q;
        return '<div class="card bank-card">'+
          '<div class="card-head"><span class="badge b-subject">'+esc(q.subject||'未分类')+'</span>'+
          '<span class="badge b-error">'+esc(q.errorType||'例题')+'</span></div>'+
          '<div class="card-body"><div class="card-text"><div class="qtext">'+esc(q.questionText||'')+'</div>'+
          '<div class="tags">'+esc((q.knowledgePoints||[]).join(' · '))+'</div></div></div>'+
          '<button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="App.addBankItem('+row.idx+')">＋ 加入我的错题本</button>'+
        '</div>';
      }).join('');
      area.innerHTML = html;
    },

    addBankItem: function (idx) {
      var q = this.bankItems[idx];
      if (!q) return;
      Store.create({
        imagePath: '', questionText: q.questionText || '', subject: q.subject || '数学',
        grade: q.grade || '初一', errorType: q.errorType || '概念不清', difficulty: q.difficulty || '基础',
        myAnswer: '', correctAnswer: q.correctAnswer || '', knowledgePoints: q.knowledgePoints || [],
        source: q.source || '公共题库', mastery: 'unmastered', reviewCount: 0
      });
      this.toast('已加入本机错题库');
    },

    /* ---------- 统计 ---------- */
    renderStats: function () {
      var items = Store.list();
      var area = document.getElementById('stats-area');
      if (items.length===0) {
        area.innerHTML = '<div class="state"><div class="big">▦</div><h3>暂无统计数据</h3><p>先录入几道错题，这里会自动生成分析</p></div>';
        return;
      }
      var total = items.length;
      var dist = function (field, order) {
        var c = {};
        items.forEach(function(it){ var k=it[field]||'未标注'; c[k]=(c[k]||0)+1; });
        return Object.keys(c).map(function(k){
          return {label:k, count:c[k], pct:Math.round(c[k]*100/total)};
        }).sort(function(a,b){return b.count-a.count;});
      };
      var bars = function (rows, color) {
        return rows.map(function(r){
          var w = r.pct<6 && r.count>0 ? 6 : r.pct;
          return '<div class="bar-row"><span class="bar-label">'+esc(r.label)+'</span>'+
            '<div class="bar-track"><div class="bar-fill" style="width:'+w+'%;background:'+color+'"></div></div>'+
            '<span class="bar-val">'+r.count+' · '+r.pct+'%</span></div>';
        }).join('');
      };
      // 掌握进度
      var mKeys = ['unmastered','reviewing','mastered'];
      var mRows = mKeys.map(function(k){
        var n = items.filter(function(it){return (it.mastery||'unmastered')===k;}).length;
        return {label:MASTERY[k], count:n, pct:Math.round(n*100/total)};
      });
      // 高频知识点
      var kc = {};
      items.forEach(function(it){ (it.knowledgePoints||[]).forEach(function(p){ kc[p]=(kc[p]||0)+1; }); });
      var kRows = Object.keys(kc).map(function(k){return {k:k,n:kc[k]};}).sort(function(a,b){return b.n-a.n;}).slice(0,5);
      var topErr = dist('errorType')[0];
      var insight = topErr ? '最常出现的错因是「'+topErr.label+'」，共 '+topErr.count+' 道，建议优先针对性复习。' : '';

      var html = '<div class="insight"><div class="lb">学情提示</div><div class="tx">'+esc(insight)+'</div>'+
        '<div style="font-size:12px;opacity:.85;margin-top:10px">已收录 '+total+' 道错题</div></div>';
      html += '<div class="stat-card"><h4>按学科分布</h4>'+bars(dist('subject'),'var(--blue)')+'</div>';
      html += '<div class="stat-card"><h4>按错因分布</h4>'+bars(dist('errorType'),'#fa8c16')+'</div>';
      html += '<div class="stat-card"><h4>掌握进度</h4>'+bars(mRows,'#52c41a')+'</div>';
      if (kRows.length) {
        html += '<div class="stat-card"><h4>高频知识点 Top 5</h4>'+
          kRows.map(function(r){return '<span class="tag">'+esc(r.k)+' ×'+r.n+'</span>';}).join('')+'</div>';
      }
      area.innerHTML = html;
    },

    /* ---------- 组卷重练 ---------- */
    renderReview: function () {
      var self = this;
      var area = document.getElementById('review-area');

      if (this.quizQueue.length > 0) {
        if (this.quizIndex >= this.quizQueue.length) {
          area.innerHTML = '<div class="state"><div class="big">✓</div><h3>本轮重练完成</h3>'+
            '<p>已掌握 '+this.quizResult.mastered+' 道 · 待巩固 '+this.quizResult.again+' 道</p>'+
            '<button class="btn btn-primary" style="margin-top:18px" onclick="App.quitQuiz()">返回组卷</button></div>';
          return;
        }
        var q = this.quizQueue[this.quizIndex];
        var img = q.imagePath ? '<img src="'+q.imagePath+'">' : '';
        var html = '<div class="progress"><span>第 '+(this.quizIndex+1)+' / '+this.quizQueue.length+' 题</span>'+
          '<a href="#" onclick="App.quitQuiz();return false" style="color:var(--hint)">退出</a></div>';
        html += '<div class="practice-q"><div class="card-head">'+
          '<span class="badge b-subject">'+esc(q.subject)+'</span>'+
          '<span class="badge b-error">'+esc(q.errorType)+'</span></div>'+img+
          '<div class="q-label">题干</div><div class="q-value">'+esc(q.questionText||'（见题目照片）')+'</div>'+
          '<div class="q-label">我当时的错答</div><div class="q-value q-wrong">'+esc(q.myAnswer||'（未填写）')+'</div>'+
          (q.source?'<div class="q-label">来源</div><div class="q-value" style="font-size:12px;color:var(--hint)">'+esc(q.source)+'</div>':'')+
          '</div>';
        if (this.quizShowAnswer) {
          html += '<div class="answer"><div class="q-label" style="color:var(--green);margin-top:0">正确答案 / 解析</div>'+
            '<div class="q-value">'+esc(q.correctAnswer||'（未填写，可返回编辑补充）')+'</div></div>'+
            '<div class="judge"><button class="btn btn-danger" onclick="App.markQuiz(\'reviewing\')">再巩固</button>'+
            '<button class="btn btn-primary" onclick="App.markQuiz(\'mastered\')">已掌握</button></div>';
        } else {
          html += '<button class="btn btn-ghost btn-block" onclick="App.revealAnswer()">显示答案</button>';
        }
        area.innerHTML = html;
        return;
      }

      // 配置态
      var pool = Store.list().filter(function(it){ return (it.mastery||'unmastered')!=='mastered'; });
      var subjOpts = ['<option value="">全部学科</option>'].concat(SUBJECTS.map(function(s){return '<option>'+s+'</option>';})).join('');
      var errOpts = ['<option value="">全部错因</option>'].concat(ERROR_TYPES.map(function(s){return '<option>'+s+'</option>';})).join('');
      if (pool.length===0) {
        area.innerHTML = '<div class="state"><div class="big">✎</div><h3>暂无待练错题</h3><p>先去录入错题，已掌握的不进入重练</p></div>';
        return;
      }
      area.innerHTML = '<div class="card">'+
        '<div class="field"><label>按学科筛选</label><select id="q-subject">'+subjOpts+'</select></div>'+
        '<div class="field"><label>按错因筛选</label><select id="q-error">'+errOpts+'</select></div>'+
        '<div style="font-size:13px;color:var(--muted);margin:4px 0 16px">待练错题：<b style="color:var(--blue)">'+pool.length+'</b> 道（已掌握的不进入重练）</div>'+
        '<button class="btn btn-primary btn-block" onclick="App.startQuiz()">开始重练</button></div>';
    },

    startQuiz: function () {
      var s = (document.getElementById('q-subject')||{}).value || '';
      var e = (document.getElementById('q-error')||{}).value || '';
      this.quizQueue = Store.list().filter(function(it){
        if ((it.mastery||'unmastered')==='mastered') return false;
        if (s && it.subject!==s) return false;
        if (e && it.errorType!==e) return false;
        return true;
      });
      if (!this.quizQueue.length) { this.toast('该范围内没有待练错题'); return; }
      this.quizIndex = 0; this.quizShowAnswer = false; this.quizResult = {mastered:0,again:0};
      this.renderReview();
    },

    revealAnswer: function () { this.quizShowAnswer = true; this.renderReview(); },

    markQuiz: function (mastery) {
      var q = this.quizQueue[this.quizIndex];
      Store.update(q.id, { mastery: mastery, reviewCount: (q.reviewCount||0)+1, lastReviewAt: Date.now() });
      this.quizResult[mastery==='mastered'?'mastered':'again'] += 1;
      this.quizIndex += 1; this.quizShowAnswer = false;
      this.renderReview();
    },

    quitQuiz: function () { this.quizQueue=[]; this.renderReview(); },

    /* ---------- 导入导出 ---------- */
    openSync: function () {
      document.getElementById('sync-mask').classList.remove('hidden');
      document.getElementById('sync-modal').classList.remove('hidden');
    },
    closeSync: function () {
      document.getElementById('sync-mask').classList.add('hidden');
      document.getElementById('sync-modal').classList.add('hidden');
    },
    exportJSON: function () {
      var data = JSON.stringify({ app:'cuoti-web', version:1, exportedAt:new Date().toISOString(), items:Store.list() }, null, 2);
      var blob = new Blob([data], {type:'application/json'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = '错题本备份_'+new Date().toISOString().slice(0,10)+'.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      this.toast('已导出备份文件');
    },
    importJSON: function (event) {
      var file = event.target.files[0]; if (!file) return;
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var obj = JSON.parse(e.target.result);
          var incoming = Array.isArray(obj.items) ? obj.items : (Array.isArray(obj)?obj:null);
          if (!incoming) { self.toast('文件格式不正确'); return; }
          var mode = confirm('点「确定」合并导入（保留现有）；点「取消」覆盖全部现有错题。');
          if (mode) {
            var merged = Store.list();
            incoming.forEach(function(it){
              if (!merged.some(function(x){return String(x.id)===String(it.id);})) merged.push(it);
            });
            Store.replaceAll(merged);
          } else {
            Store.replaceAll(incoming);
          }
          self.closeSync(); self.renderList();
          self.toast('已导入 '+incoming.length+' 道错题');
        } catch (err) { self.toast('导入失败：文件格式错误'); }
      };
      reader.readAsText(file);
      event.target.value = '';
    },

    /* ---------- 启动 ---------- */
    loadFromQuery: function () {
      var params = new URLSearchParams(location.search);
      var editId = params.get('edit');
      if (editId) { this.edit(editId); }
    }
  };

  window.App = App;
  document.addEventListener('DOMContentLoaded', function(){ App.init(); });
})();

function esc(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
