/* 错题本 Web App
 * 数据层：默认 localStorage（保留图片 dataURL），抽象为 Store 接口。
 * 云同步：CloudAdapter 预留，未来开通 WorkBuddy 云服务后接入即可无缝切换。
 */
(function () {
  'use strict';

  var SUBJECTS = ['语文','数学','英语','物理','化学','生物','政治','历史','地理'];
  var DIFFICULTIES = ['基础','中等','较难'];
  var ERROR_TYPES = ['概念不清','计算失误','审题偏差','粗心马虎','方法不会'];
  var MASTERY = { unmastered:'未掌握', reviewing:'巩固中', mastered:'已掌握' };
  var STORAGE_KEY = 'cuoti-web-v1';
  var OCR_KEY_STORAGE = 'cuoti-ocrspace-key';   // 用户自填的云端OCR key（仅存本机）
  var OCR_CONSENT_STORAGE = 'cuoti-cloud-ocr-consent';
  var OCRSPACE_DEFAULT_KEY = 'helloworld';     // 官方公共测试key（有速率限制，仅测试用）
  var BANK_URL = 'questions.json';             // 公共题库（只读，不含学生数据）
  // 视觉大模型：前端直连 SiliconFlow 官方 API（国内可直连、支持浏览器跨域）。
  // API Key 仅存本机浏览器 localStorage，绝不写入公开源码。
  var VISION_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
  var VISION_KEY_STORAGE = 'cuoti-vision-key';
  var VISION_MODELS = ['Qwen/Qwen3-VL-8B-Instruct', 'Qwen/Qwen3-VL-30B-A3B-Instruct'];
  var VISION_CONSENT_STORAGE = 'cuoti-vision-consent';

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
    quizQueue: [], quizIndex: 0, quizShowAnswer: false, quizResult:{mastered:0,again:0},

    init: function () {
      this.fillSelect('f-diff-filter', DIFFICULTIES, '全部难度');
      this.fillSelect('f-error', ERROR_TYPES, '全部错因');
      this.fillSelect('f-errtype', ERROR_TYPES);
      this.fillSelect('bank-subject', SUBJECTS, '全部学科');
      var savedKey = localStorage.getItem(OCR_KEY_STORAGE) || '';
      var keyInput = document.getElementById('ocr-key');
      if (keyInput) keyInput.value = savedKey;
      var visionKeyInput = document.getElementById('vision-key');
      if (visionKeyInput) visionKeyInput.value = this.getVisionKey();
      this.renderVisionKeyState();
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
      var diffFilter = (document.getElementById('f-diff-filter')||{}).value || '';
      var error = (document.getElementById('f-error')||{}).value || '';
      keyword = keyword.trim().toLowerCase();

      var items = Store.list().filter(function(it){
        if (diffFilter && it.difficulty!==diffFilter) return false;
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
        var tags = (it.knowledgePoints||[]).slice(0,3).join(' · ');
        // 题干：新版存 questionHtml 直接按富文本渲染；老数据用纯文本转义兜底
        var qHtml = it.questionHtml ? sanitizeRichHtml(it.questionHtml) : esc(it.questionText || '');
        if (!qHtml) qHtml = '<span style="color:var(--hint)">（见题目照片）</span>';
        var mKey = it.mastery || 'unmastered';
        var mClass = mKey==='mastered'?'b-mastered':(mKey==='reviewing'?'b-reviewing':'b-unmastered');
        var d = new Date(it.updatedAt||Date.now());
        var time = (d.getMonth()+1)+'-'+d.getDate();
        var img = it.imagePath ? '<img class="thumb" src="'+it.imagePath+'" onclick="event.stopPropagation();App.viewImage(\''+it.id+'\')">' : '';
        // 同步展示字段：错因 / 难度 / 我的错答 / 正确答案解析
        var detail = '';
        detail += '<div class="detail-row"><span class="dk">错因</span><span class="dv">'+esc(it.errorType||'未标注')+'</span></div>';
        detail += '<div class="detail-row"><span class="dk">难度</span><span class="dv">'+esc(it.difficulty||'未标注')+'</span></div>';
        if (it.myAnswer) detail += '<div class="detail-row wrong"><span class="dk">我的错答</span><span class="dv">'+esc(it.myAnswer)+'</span></div>';
        if (it.correctAnswer) detail += '<div class="detail-row right"><span class="dk">正确答案</span><span class="dv">'+esc(it.correctAnswer)+'</span></div>';
        return '<div class="card" onclick="App.edit(\''+it.id+'\')">'+
          '<div class="card-head">'+
            '<span class="badge b-subject">'+esc(it.subject||'未分类')+'</span>'+
            '<span class="badge '+mClass+'">'+MASTERY[mKey]+'</span>'+
            '<span class="card-time">'+time+'</span>'+
          '</div>'+
          '<div class="card-body">'+img+'<div class="card-text">'+
            '<div class="qtext">'+qHtml+'</div>'+
            (tags?'<div class="tags">'+esc(tags)+'</div>':'')+
          '</div></div>'+
          detail+
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
      document.getElementById('f-question').innerHTML = '';
      document.getElementById('f-myanswer').value = '';
      document.getElementById('f-correct').value = '';
      document.getElementById('f-knowledge').value = '';
      document.getElementById('f-source').value = '';
      document.getElementById('f-errtype').value = ERROR_TYPES[0];
      document.getElementById('f-diff').value = '基础';
      document.getElementById('f-mastery').value = 'unmastered';
      document.getElementById('mastery-field').classList.add('hidden');
      document.getElementById('preview').classList.add('hidden');
      document.getElementById('imgbox').classList.remove('hidden');
      document.getElementById('del-btn').classList.add('hidden');
      document.getElementById('ocr-status').textContent = '拍照后点云端识别，结果会自动填入题干';
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
      document.getElementById('f-question').innerHTML = it.questionHtml || esc(it.questionText || '');
      document.getElementById('f-myanswer').value = it.myAnswer || '';
      document.getElementById('f-correct').value = it.correctAnswer || '';
      document.getElementById('f-knowledge').value = (it.knowledgePoints||[]).join('、');
      document.getElementById('f-source').value = it.source || '';
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
      document.getElementById('ocr-status').textContent = '拍照后点云端识别，结果会自动填入题干';
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
      var qHtml = sanitizeRichHtml(document.getElementById('f-question').innerHTML);
      var qText = richHtmlToText(qHtml).trim();
      if (!qText && !this.currentImage) { this.toast('请拍照或填写题干'); return; }
      var old = this.editingId ? Store.get(this.editingId) : null;
      var data = {
        imagePath: this.currentImage,
        questionText: qText,
        questionHtml: qHtml,
        subject: (old && old.subject) || '未分类',
        grade: (old && old.grade) || '未分类',
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

    /* ---------- OCR 后处理与校对（云端识别共用） ---------- */

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

    // 把纯文本以 HTML 富文本形式写入题干：转义防注入，换行转 <br>，全部内容不截断
    fillQuestionHtml: function (text, append) {
      var el = document.getElementById('f-question');
      if (!el || !text) return;
      var html = sanitizeRichHtml(esc(text).replace(/\n/g, '<br>'));
      if (append && el.innerHTML.trim()) {
        el.innerHTML = el.innerHTML.replace(/(<br\s*\/?\s*>|\s)+$/, '') + '<br>' + html;
      } else {
        el.innerHTML = html;
      }
    },

    // 把校对区结果填入富文本题干（replace）或追加（append）
    applyOCR: function (append) {
      var text = document.getElementById('ocr-result').value.trim();
      if (!text) { this.toast('校对区为空'); return; }
      this.fillQuestionHtml(text, append);
      this.toast(append ? '已追加到题干' : '已填入题干');
      try { document.getElementById('f-question').focus(); } catch (e) {}
    },

    // 富文本工具栏命令（加粗/上下标/标红等）
    richCmd: function (cmd, val) {
      var el = document.getElementById('f-question');
      if (!el) return;
      try { el.focus(); document.execCommand(cmd, false, val || null); } catch (e) {}
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
        var ok = confirm('云端识别说明\n\n· 题目照片将上传到第三方服务 OCR.space 进行识别\n· 识别完成后网页不会保存照片副本，但第三方会短暂处理该图片\n· 若不希望照片外传，请手动录入题干\n\n是否同意并继续？');
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
          // 关键：识别后自动把全部内容以 HTML 富文本形式填入题干，并滚动到题干让用户看到
          self.fillQuestionHtml(text, false);
          document.getElementById('ocr-result').value = text;
          review.classList.remove('hidden');
          confEl.innerHTML = '<b style="color:var(--green)">云端识别完成 · 已自动填入题干</b>' +
            (self.getOCRKey() === OCRSPACE_DEFAULT_KEY ? ' · 使用公共测试key（有速率限制）' : '');
          status.textContent = '识别完成，全部内容已填入下方题干';
          self.toast('识别完成，已填入题干');
          try {
            var q = document.getElementById('f-question');
            q.scrollIntoView({ behavior: 'smooth', block: 'center' });
            q.classList.add('ocr-flash');
            setTimeout(function () { q.classList.remove('ocr-flash'); }, 1200);
          } catch (e) {}
        })
        .catch(function (err) {
          var msg = String(err && err.message || err);
          status.textContent = '云端识别失败：' + msg.slice(0, 40);
          self.toast('云端识别失败，请手动输入或重试');
          console.error(err);
        })
        .then(function () { btn.disabled = false; });
    },

    /* ---------- 视觉大模型 OCR（经 Cloudflare 代理，Key 藏服务端，页面零配置） ---------- */

    /* ---------- 视觉模型 Key（仅存本机浏览器，不进公开源码） ---------- */
    getVisionKey: function () {
      return (localStorage.getItem(VISION_KEY_STORAGE) || '').trim();
    },
    saveVisionKey: function () {
      var input = document.getElementById('vision-key');
      var v = (input && input.value || '').trim();
      if (v) {
        localStorage.setItem(VISION_KEY_STORAGE, v);
        this.toast('视觉模型 Key 已保存（仅存本机）');
        if (input) input.value = v;
      } else {
        localStorage.removeItem(VISION_KEY_STORAGE);
        this.toast('已清除 Key');
      }
      this.renderVisionKeyState();
    },
    renderVisionKeyState: function () {
      var tip = document.getElementById('vision-key-state');
      if (!tip) return;
      var has = !!this.getVisionKey();
      tip.textContent = has ? '已保存 Key（仅存本机浏览器，可直接使用）' : '尚未保存 Key，请粘贴后点「保存」';
      tip.style.color = has ? 'var(--green)' : '#c0392b';
    },
    showVisionCfg: function () {
      var box = document.getElementById('vision-cfg');
      if (box) {
        box.classList.remove('hidden');
        var input = document.getElementById('vision-key');
        if (input) { try { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
      }
    },

    // 视觉识别 Prompt：要求输出纯 HTML 片段，分数用 .frac 结构，保留题号与选项
    VISION_PROMPT: '这是一道中国初中数学题的照片。请把【印刷体题干】完整转录为 HTML 富文本片段，严格遵循：\n' +
      '1. 只输出题干的 HTML，不要任何解释、不要 markdown 代码块、不要引言。\n' +
      '2. 分数必须写成 <span class="frac"><span class="n">分子</span><span class="d">分母</span></span>，例如 5/8 写成 <span class="frac"><span class="n">5</span><span class="d">8</span></span>。\n' +
      '3. 上标用 <sup>，下标用 <sub>；根号用 √ 符号；乘号用 ×，除号用 ÷。\n' +
      '4. 保留题号（如"6."）、括号、单位、选项（A/B/C/D）与换行；换行用 <br>。\n' +
      '5. 填空题括号里的手写答案是学生作答，绝对不要识别；只保留印刷体的空括号（　），不要把整数手写答案套成分数（如把 30 写成 30/1）。\n' +
      '6. 不要包含红笔/铅笔的手写批改、手写答案、分数得分、页眉页脚（学校/班级/第X页）。\n' +
      '7. 看不清的字用 □ 代替，不要猜测。\n' +
      '现在开始转录：',

    runVisionOCR: function () {
      var self = this;
      if (!this.currentImage) { this.toast('请先选择照片'); return; }
      var key = this.getVisionKey();
      if (!key) { this.toast('请先填写 SiliconFlow API Key'); this.showVisionCfg(); return; }

      var consented = localStorage.getItem(VISION_CONSENT_STORAGE) === '1';
      if (!consented) {
        var ok = confirm('视觉大模型识别说明\n\n· 题目照片将直接上传到 SiliconFlow（硅基流动）由视觉模型识别\n· 视觉模型能正确识别分数、公式等版式，识别率远高于传统 OCR\n· 网页不保存照片副本，第三方会短暂处理该图片\n· 使用你自填的 API Key（仅存本机浏览器），免费模型不产生费用\n\n是否同意并继续？');
        if (!ok) return;
        localStorage.setItem(VISION_CONSENT_STORAGE, '1');
      }

      var btn = document.getElementById('vision-btn');
      var status = document.getElementById('ocr-status');
      var confEl = document.getElementById('ocr-conf');
      var review = document.getElementById('ocr-review');
      btn.disabled = true; review.classList.add('hidden'); confEl.textContent = '';
      status.textContent = '视觉模型识别中（约 3-8 秒）…';

      var model = (document.getElementById('vision-model') || {}).value || VISION_MODELS[0];
      var payload = {
        model: model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: self.VISION_PROMPT },
          { type: 'image_url', image_url: { url: this.currentImage } }
        ]}],
        max_tokens: 1500,
        temperature: 0
      };

      fetch(VISION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(payload)
      })
      .then(function (r) {
        return r.json().then(function (d) { if (!r.ok) throw new Error(d.message || d.error || ('HTTP ' + r.status)); return d; });
      })
      .then(function (d) {
        var content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
        var html = String(content).trim();
        // 清理模型可能的 markdown 代码块围栏
        html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
        if (!html) { status.textContent = '视觉模型未返回内容'; self.toast('未识别到内容'); return; }
        // 清洗后填入题干（扩展白名单支持 .frac 分数结构）
        var safe = sanitizeVisionHtml(html);
        self.fillQuestionRawHtml(safe);
        document.getElementById('ocr-result').value = richHtmlToText(safe);
        review.classList.remove('hidden');
        confEl.innerHTML = '<b style="color:var(--green)">视觉识别完成 · 已填入题干</b>';
        status.textContent = '识别完成，题干已按 HTML 富文本呈现（分数为上下结构）';
        self.toast('视觉识别完成');
        try {
          var q = document.getElementById('f-question');
          q.scrollIntoView({ behavior: 'smooth', block: 'center' });
          q.classList.add('ocr-flash');
          setTimeout(function () { q.classList.remove('ocr-flash'); }, 1200);
        } catch (e) {}
      })
      .catch(function (err) {
        var msg = String(err && err.message || err);
        var friendly = /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(msg)
          ? '无法连接 SiliconFlow（请检查网络）'
          : /invalid|unauthor|token|401|403/i.test(msg)
            ? 'API Key 无效或额度不足，请检查后重新保存'
            : msg.slice(0, 90);
        status.textContent = '视觉识别失败：' + friendly;
        if (confEl) confEl.innerHTML = '<b style="color:#e74c3c">识别失败：' + friendly + '</b>';
        self.toast('识别失败：' + friendly);
        console.error(err);
      })
      .then(function () { btn.disabled = false; });
    },

    // 直接把 HTML 写入题干（用于视觉模型已结构化的输出）
    fillQuestionRawHtml: function (html) {
      var el = document.getElementById('f-question');
      if (el) el.innerHTML = html;
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
        imagePath: '', questionText: q.questionText || '', questionHtml: esc(q.questionText || ''),
        subject: q.subject || '数学',
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
      html += '<div class="stat-card"><h4>按难度分布</h4>'+bars(dist('difficulty'),'var(--blue)')+'</div>';
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
        var qHtml = q.questionHtml ? sanitizeRichHtml(q.questionHtml) : esc(q.questionText||'');
        if (!qHtml) qHtml = '<span style="color:var(--hint)">（见题目照片）</span>';
        html += '<div class="practice-q"><div class="card-head">'+
          '<span class="badge b-subject">'+esc(q.subject||'未分类')+'</span>'+
          '<span class="badge b-error">错因：'+esc(q.errorType||'未标注')+'</span>'+
          '<span class="badge b-error">难度：'+esc(q.difficulty||'未标注')+'</span></div>'+img+
          '<div class="q-label">题干</div><div class="q-value">'+qHtml+'</div>'+
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

/* 富文本 HTML 白名单清洗：只保留安全排版标签，剥离 script、事件属性、javascript 协议。
   题干由本人在本机录入，但仍做清洗，避免粘贴网页时带入危险脚本。 */
function sanitizeRichHtml(html) {
  var s = String(html == null ? '' : html);
  // 移除整个危险块
  s = s.replace(/<(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\/\1>/gi, '')
       .replace(/<script[^>]*\/?>/gi, '');
  // 移除所有 on* 事件属性、javascript: 协议、srcdoc
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
       .replace(/\s(srcdoc|href)\s*=\s*(["']?)\s*javascript:[\s\S]*?\2/gi, '')
       .replace(/javascript:/gi, '');
  // 移除 pt 之类无关属性，收敛 img 到仅 data:image（题目照片以 dataURL 存）
  s = s.replace(/<img([^>]*)>/gi, function (m, attrs) {
    var srcM = /\bsrc\s*=\s*(["'])(data:image\/[^"']+)\1/i.exec(attrs) || /\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/i.exec(attrs);
    if (!srcM) return '';
    var altM = /\balt\s*=\s*(["'])([^"']*)\1/i.exec(attrs);
    return '<img src="' + srcM[2] + '"' + (altM ? ' alt="' + altM[2] + '"' : '') + '>';
  });
  // 标签白名单：保留常见排版标签，剥掉其余标签但保留其文字
  var allow = /^<\/?(b|strong|i|em|u|s|sub|sup|br|div|p|span|ul|ol|li|blockquote|font|img)(\s[^>]*)?\/?>$/i;
  s = s.replace(/<[^>]+>/g, function (tag) {
    if (allow.test(tag)) {
      // 对保留标签，收敛 style 只留颜色/字体粗细相关，去掉 position/url 等
      return tag.replace(/\sstyle\s*=\s*(["'])([^"']*)\1/ig, function (sm, q, css) {
        var safeCss = css.split(';').filter(function (rule) {
          return /^\s*(color|background-color|font-weight|font-style|text-decoration|font-size)\s*:/i.test(rule) && !/url\(|expression|position/i.test(rule);
        }).join(';');
        return safeCss ? ' style="' + safeCss + '"' : '';
      }).replace(/\scolor\s*=\s*(["']?)[^"'\s>]+\1/ig, '');
    }
    return '';
  });
  return s.trim();
}

/* 视觉模型输出清洗：在通用白名单基础上，保留 span 的 class（frac/n/d）与分数结构 */
function sanitizeVisionHtml(html) {
  var s = sanitizeRichHtml(html);
  // sanitizeRichHtml 会保留 <span> 标签但可能清理 style；这里确保分数三件套的 class 存在
  // 由于通用清洗已保留 span 及其属性，通常无需额外处理；做一次兜底规范化
  s = s.replace(/<span\s+class=["']frac["']\s*>/gi, '<span class="frac">')
       .replace(/<span\s+class=["']n["']\s*>/gi, '<span class="n">')
       .replace(/<span\s+class=["']d["']\s*>/gi, '<span class="d">');
  // 视觉模型常把填空里的手写整数答案误套成分数（如 30/1、2/1）。
  // 初中题干分母为 1 的分数极罕见，统一规整为普通数字，避免题干出现 "30/1"。
  s = s.replace(/<span class="frac">\s*<span class="n">([^<]+)<\/span>\s*<span class="d">1<\/span>\s*<\/span>/g, '$1');
  return s;
}

/* 富文本 HTML → 纯文本（保留换行与块分隔），用于搜索与摘要 */
function richHtmlToText(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(div|p|li|blockquote|ul|ol)>/gi, '\n')
       .replace(/<[^>]+>/g, '')
       .replace(/&nbsp;/gi, ' ')
       .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
       .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  return s;
}
