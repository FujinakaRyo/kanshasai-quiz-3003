/* PPTX generation — loaded as /pptx-gen.js (served statically, outside template literal) */

function xmlEsc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function replaceInShape(xml, id, txt){
  var p = xml.indexOf('id="'+id+'" ');
  if(p === -1) p = xml.indexOf('id="'+id+'"');
  if(p === -1) return xml;
  var ts = xml.indexOf('<a:t>', p), te = xml.indexOf('</a:t>', ts);
  if(ts === -1 || te === -1) return xml;
  return xml.slice(0, ts+5) + txt + xml.slice(te);
}

function makeQSlide(tmpl, q){
  var xml = tmpl;
  xml = replaceInShape(xml, '8', xmlEsc(q.text));
  // shape id: 17=上左①, 19=上右②, 18=下左③, 20=下右④
  var cids = ['17','19','18','20'];
  for(var i = 0; i < 4; i++){
    var t = (q.choices && q.choices[i]) ? xmlEsc(q.choices[i].text || '') : '';
    xml = replaceInShape(xml, cids[i], t);
  }
  return xml;
}

function removeRelById(xml, id){
  var p = xml.indexOf('Id="'+id+'"');
  if(p === -1) return xml;
  var s = xml.lastIndexOf('<Relationship', p), e = xml.indexOf('/>', p) + 2;
  return xml.slice(0, s) + xml.slice(e);
}

function stripNotesRels(rels){
  var out = '', pos = 0;
  while(true){
    var s = rels.indexOf('<Relationship', pos);
    if(s === -1){ out += rels.slice(pos); break; }
    out += rels.slice(pos, s);
    var e = rels.indexOf('/>', s) + 2, chunk = rels.slice(s, e);
    if(chunk.indexOf('notesSlide') === -1) out += chunk;
    pos = e;
  }
  return out;
}

function updPresXml(xml, n){
  var s = xml.indexOf('<p:sldIdLst>'), e = xml.indexOf('</p:sldIdLst>') + 13;
  var ids = '<p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/>';
  for(var i = 0; i < n; i++) ids += '<p:sldId id="'+(300+i)+'" r:id="rId'+(100+i)+'"/>';
  ids += '<p:sldId id="299" r:id="rId'+(100+n)+'"/>';
  return xml.slice(0, s) + '<p:sldIdLst>' + ids + '</p:sldIdLst>' + xml.slice(e);
}

function updPresRels(xml, n){
  var st = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
  var r = removeRelById(removeRelById(removeRelById(xml,'rId4'),'rId5'),'rId6');
  var add = '';
  for(var i = 0; i < n+1; i++) add += '<Relationship Id="rId'+(100+i)+'" Type="'+st+'" Target="slides/slide'+(3+i)+'.xml"/>';
  return r.replace('</Relationships>', add + '</Relationships>');
}

function removeOverrideByName(xml, name){
  var p = xml.indexOf('PartName="'+name+'"');
  if(p === -1) return xml;
  var s = xml.lastIndexOf('<Override', p), e = xml.indexOf('/>', p) + 2;
  return xml.slice(0, s) + xml.slice(e);
}

function updCtypes(xml, n){
  var ct = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
  // 差し替えるスライドのOverrideを削除
  var r = removeOverrideByName(removeOverrideByName(removeOverrideByName(xml,'/ppt/slides/slide3.xml'),'/ppt/slides/slide4.xml'),'/ppt/slides/slide5.xml');
  // スライド3〜5と対になるnotesSlide（slide4を参照するnotesSlide3など）も削除し、
  // 孤立ノーツによるOPC到達可能性違反を防ぐ
  r = removeOverrideByName(removeOverrideByName(r,'/ppt/notesSlides/notesSlide2.xml'),'/ppt/notesSlides/notesSlide3.xml');
  r = removeOverrideByName(r,'/ppt/tags/tag4.xml');
  var add = '';
  for(var i = 0; i < n+1; i++) add += '<Override PartName="/ppt/slides/slide'+(3+i)+'.xml" ContentType="'+ct+'"/>';
  return r.replace('</Types>', add + '</Types>');
}

async function generatePptx(){
  var qs = (typeof V !== 'undefined' && V && V.questions) ? V.questions : [];
  if(!qs.length){ alert('問題が登録されていません。先に問題を追加してください。'); return; }
  var btn = document.getElementById('pptxBtn');
  function setBtn(loading){
    if(btn){ btn.disabled = loading; btn.textContent = loading ? '生成中...' : '📥 PPTX生成'; }
  }
  setBtn(true);
  try{
    var res = await fetch('/api/admin/template-pptx');
    if(!res.ok){ alert('テンプレートファイルが見つかりません'); setBtn(false); return; }
    var buf = await res.arrayBuffer();
    var srcZip = await JSZip.loadAsync(buf);
    var dst = new JSZip();
    var s3xml   = await srcZip.file('ppt/slides/slide3.xml').async('string');
    var s3rels  = await srcZip.file('ppt/slides/_rels/slide3.xml.rels').async('string');
    var s5xml   = await srcZip.file('ppt/slides/slide5.xml').async('string');
    var s5rels  = await srcZip.file('ppt/slides/_rels/slide5.xml.rels').async('string');
    var presxml  = await srcZip.file('ppt/presentation.xml').async('string');
    var presrels = await srcZip.file('ppt/_rels/presentation.xml.rels').async('string');
    var ctypes   = await srcZip.file('[Content_Types].xml').async('string');
    var qrels = stripNotesRels(s3rels);
    var skip = {
      'ppt/slides/slide3.xml':1,'ppt/slides/slide4.xml':1,'ppt/slides/slide5.xml':1,
      'ppt/slides/_rels/slide3.xml.rels':1,'ppt/slides/_rels/slide4.xml.rels':1,'ppt/slides/_rels/slide5.xml.rels':1,
      // slide3/4を参照するnotesSlide2/3 → 生成スライドからの逆参照が切れるため除外
      'ppt/notesSlides/notesSlide2.xml':1,'ppt/notesSlides/notesSlide3.xml':1,
      'ppt/notesSlides/_rels/notesSlide2.xml.rels':1,'ppt/notesSlides/_rels/notesSlide3.xml.rels':1,
      // tag4はslide4専用だったが今回slide4の元relsを使わないため参照されなくなる(OPC孤立)
      'ppt/tags/tag4.xml':1,
      'ppt/presentation.xml':1,'ppt/_rels/presentation.xml.rels':1,'[Content_Types].xml':1
    };
    var proms = [];
    srcZip.forEach(function(path, file){
      if(!file.dir && !skip[path]) proms.push(file.async('uint8array').then(function(d){ dst.file(path, d); }));
    });
    await Promise.all(proms);
    var n = qs.length;
    for(var i = 0; i < n; i++){
      dst.file('ppt/slides/slide'+(3+i)+'.xml', makeQSlide(s3xml, qs[i]));
      dst.file('ppt/slides/_rels/slide'+(3+i)+'.xml.rels', qrels);
    }
    dst.file('ppt/slides/slide'+(3+n)+'.xml', s5xml);
    dst.file('ppt/slides/_rels/slide'+(3+n)+'.xml.rels', s5rels);
    dst.file('ppt/presentation.xml', updPresXml(presxml, n));
    dst.file('ppt/_rels/presentation.xml.rels', updPresRels(presrels, n));
    dst.file('[Content_Types].xml', updCtypes(ctypes, n));
    var blob = await dst.generateAsync({type:'blob', compression:'DEFLATE', compressionOptions:{level:6}});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'quiz_' + (new Date().toLocaleDateString('ja-JP').replace(/\//g,'-')) + '.pptx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 3000);
    setBtn(false);
  } catch(e){
    alert('PPTX生成に失敗しました: ' + e.message);
    console.error(e);
    setBtn(false);
  }
}
