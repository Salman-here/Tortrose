'use strict';

// Presentation only: keeps the approved gallery design and replaces its
// controls with source/activity-aware controls. No transport or business code.
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function sourceGalleryControls(html, entries, coverage = {}) {
  const data = JSON.stringify(entries).replace(/</g, '\\u003c');
  const families = coverage.sourceFamilies || [];
  const sites = coverage.fixedWhatsAppSendSites || [];
  const producerSites = coverage.notificationCallSites || [];
  const scope = '<div class="scope" role="group" aria-label="Preview inventory"><button id="activeOnly" type="button" aria-pressed="true">Active messages</button><button id="allMessages" type="button" aria-pressed="false">All references · includes exceptions and retained code</button><label for="audience">Audience</label><select id="audience"><option value="all">All audiences</option><option value="buyer">Buyers</option><option value="seller">Sellers</option><option value="admin">Admins</option></select></div>';
  const inventory = '<details class="inventory"><summary>Coverage and preview limitations</summary><p>Source-backed local previews with dummy data. ' + families.length + ' notification producer families, ' + producerSites.length + ' producer call sites and ' + sites.length + ' direct WhatsApp send sites are accounted for. This is a message inventory, not proof of live delivery.</p><ul>'
    + families.map(family => '<li><strong>' + escape(family.sourcePath) + '</strong> — ' + escape(family.scope) + '</li>').join('')
    + '</ul><p>AI-generated conversations are not fixed templates. In-app and push tabs show source-authored notification text, not a screenshot of a running app. Original-account Raast refund review samples are exceptions, not normal Wallet cancellations. Retained Stripe-specific risk/cleanup producers are excluded from active Safepay previews.</p><p>Old comparisons are read from pinned Git history where a matching source definition exists. New is the approved source version. Deployment and delivery status are reported separately in the chat. This gallery sends no messages.</p></details>';
  const styles = '\n.scope{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.scope button{border:1px solid #bed1e8;background:white;color:#33415d;border-radius:10px;padding:9px 13px;font-weight:650;cursor:pointer}.scope button[aria-pressed=true]{background:#edf3ff;border-color:#818cf8;color:#3730a3}.inventory{font-size:12px;color:#62728b;margin-top:12px;max-width:1100px}.inventory summary{cursor:pointer;font-weight:650}.inventory li{margin:6px 0}.inventory ul{padding-left:20px}.version button:disabled{opacity:.45;cursor:not-allowed}.sidebar{max-height:calc(100vh - 240px)}@media(max-width:760px){.sidebar{max-height:230px}}\n';
  const script = `
const entries=JSON.parse(document.getElementById('preview-data').textContent);
const buttons=[...document.querySelectorAll('.template')],frame=document.getElementById('preview'),search=document.getElementById('search');
let selected=0,activeChannel='email',activeVersion='new',activeOnly=true,noMatches=false,activeAudience='all';
const channelLabels={email:'Email',whatsapp:'WhatsApp',inapp:'Web & mobile inbox',push:'Push notification'};
const isActive=item=>!item.activity||item.activity==='active';
const audienceMatches=item=>activeAudience==='all'||!item.audienceRole||item.audienceRole==='general'||item.audienceRole===activeAudience;
function setVersions(item){
 const old=document.getElementById('oldVersion'),hasOld=!!item.before;
 old.disabled=!hasOld;old.setAttribute('aria-disabled',String(!hasOld));
 old.title=hasOld?'Pinned before-change source':'No verified historical preview is available; no Old copy has been invented.';
 if(!hasOld)activeVersion='new';
 old.setAttribute('aria-pressed',String(activeVersion==='old'));
 document.getElementById('newVersion').setAttribute('aria-pressed',String(activeVersion==='new'));
}
function appendWhatsAppText(target,value){target.replaceChildren();for(const part of String(value||'').split(/([*_][^*_\\n]+[*_])/g)){if(!part)continue;if((part[0]==='*'||part[0]==='_')&&part.at(-1)===part[0]&&part.length>2){const el=document.createElement(part[0]==='*'?'strong':'em');el.textContent=part.slice(1,-1);target.append(el);}else target.append(document.createTextNode(part));}}
function show(index){
 selected=index;const item=entries[index];setVersions(item);
 const version=activeVersion==='old'?item.before:item.after;
 const classification=item.activity==='legacy'?'Retained code — not an active Safepay message':item.activity==='exception'?'Exception reference — not the normal flow':['review-required','review_required'].includes(item.activity)?'Definition needs runtime review':'Active message definition';
 const versionLabel=activeVersion==='old'?'Old source snapshot'+(item.sourceBaseline?' · '+item.sourceBaseline.slice(0,8):''):'Approved source preview';
 document.getElementById('title').textContent=item.name;
 document.getElementById('meta').textContent=item.group+' · '+(item.audienceRole||'Shared')+' · '+classification+' · '+versionLabel+(item.sourcePath?' · '+item.sourcePath+(item.sourceLine?':'+item.sourceLine:''):'')+(item.channel==='email'?' · Subject: '+version.subject:'');
 document.getElementById('emailPane').hidden=item.channel!=='email';document.getElementById('whatsappPane').hidden=item.channel==='email';
 document.getElementById('emailNote').hidden=item.channel!=='email';document.getElementById('waNote').hidden=item.channel==='email';
 document.getElementById('waDevice').classList.toggle('app-preview',item.channel==='inapp'||item.channel==='push');
 document.getElementById('waPreviewChannel').textContent=channelLabels[item.channel]+' preview';
 if(item.channel==='email')frame.srcdoc=version.html;
 else{const subject=document.getElementById('waSubject');subject.hidden=!version.title;subject.textContent=version.title||'';const message=document.getElementById('waMessage');if(item.channel==='whatsapp')appendWhatsAppText(message,version.message);else{message.replaceChildren();message.textContent=version.message||'';}const footer=document.getElementById('waFooter');footer.hidden=!version.footer;footer.textContent=version.footer||'';const actions=document.getElementById('waActions');actions.replaceChildren();for(const label of version.buttons||[]){const row=document.createElement('div');row.className='wa-action';row.textContent=label;actions.append(row);}}
 buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));
 const note='Template preview with dummy data; see the chat for deployment status. '+(item.before?'Old and New compare this same definition.':'Old is unavailable for this definition and is disabled rather than fabricated.')+(item.note?' '+item.note:'');
 document.getElementById(item.channel==='email'?'emailNote':'waNote').textContent=note;
}
function refreshList(){
 const query=search.value.toLowerCase().trim();let visible=0;
 for(const [index,button]of buttons.entries()){
  const item=entries[index],matches=item.channel===activeChannel&&(!activeOnly||isActive(item))&&audienceMatches(item)&&(item.group+' '+item.name+' '+(item.before?.subject||'')+' '+(item.after.subject||'')+' '+(item.sourcePath||'')).toLowerCase().includes(query);
  button.hidden=!matches;if(matches)visible++;
 }
 const scopeCount=entries.filter(item=>item.channel===activeChannel&&(!activeOnly||isActive(item))&&audienceMatches(item)).length;
 document.getElementById('count').textContent=visible+' of '+scopeCount+' '+activeChannel+' templates'+(activeOnly?' · active definitions':' · all references');
 for(const channel of Object.keys(channelLabels))document.getElementById(channel+'Tab').textContent=channelLabels[channel]+' · '+entries.filter(item=>item.channel===channel&&(!activeOnly||isActive(item))&&audienceMatches(item)).length;
 if(!visible){noMatches=true;document.getElementById('title').textContent='No matching templates';document.getElementById('meta').textContent='Try a different search or include retained references.';document.getElementById('emailPane').hidden=true;document.getElementById('whatsappPane').hidden=true;document.getElementById('emailNote').hidden=true;document.getElementById('waNote').hidden=true;return;}
 if(noMatches||selected<0||!buttons[selected]||buttons[selected].hidden){noMatches=false;show(Number(buttons.find(button=>!button.hidden).dataset.index));}
}
function channel(next){activeChannel=next;search.value='';for(const name of Object.keys(channelLabels))document.getElementById(name+'Tab').setAttribute('aria-selected',String(next===name));selected=entries.findIndex(item=>item.channel===next&&(!activeOnly||isActive(item))&&audienceMatches(item));refreshList();if(selected>=0)show(selected);}
buttons.forEach(button=>button.addEventListener('click',()=>show(Number(button.dataset.index))));search.addEventListener('input',refreshList);
for(const name of Object.keys(channelLabels))document.getElementById(name+'Tab').addEventListener('click',()=>channel(name));
document.getElementById('audience').addEventListener('change',()=>{activeAudience=document.getElementById('audience').value;refreshList();});
for(const version of ['old','new'])document.getElementById(version+'Version').addEventListener('click',()=>{if(noMatches||selected<0||version==='old'&&!entries[selected]?.before)return;activeVersion=version;show(selected);});
for(const [id,value]of [['activeOnly',true],['allMessages',false]])document.getElementById(id).addEventListener('click',()=>{activeOnly=value;document.getElementById('activeOnly').setAttribute('aria-pressed',String(value));document.getElementById('allMessages').setAttribute('aria-pressed',String(!value));refreshList();});
for(const mode of ['desktop','phone'])document.getElementById(mode).addEventListener('click',()=>{frame.classList.toggle('phone',mode==='phone');document.getElementById('waDevice').classList.toggle('phone',mode==='phone');document.getElementById('desktop').setAttribute('aria-pressed',String(mode==='desktop'));document.getElementById('phone').setAttribute('aria-pressed',String(mode==='phone'));});
show(0);refreshList();
`;
  return html.replace('</style>', styles + '</style>')
    .replace('</style>', '.scope label{font-size:12px;margin-left:8px;align-self:center}.scope select{border:1px solid #bed1e8;border-radius:10px;padding:9px;background:white;color:#33415d}.app-preview .wa-thread{background:linear-gradient(130deg,#e5efff,#eee9fb)}.app-preview .wa-bubble{border:1px solid #fff;border-radius:16px;background:rgba(255,255,255,.8);color:#27344e;max-width:100%;width:100%}.app-preview .wa-header{background:#f5f7ff}.channels{flex-wrap:wrap}</style>')
    .replace('</div></header>', '<button id="inappTab" type="button" role="tab" aria-selected="false">Web & mobile inbox</button><button id="pushTab" type="button" role="tab" aria-selected="false">Push notification</button></div></header>')
    .replace('<small>WhatsApp message preview</small>', '<small id="waPreviewChannel">WhatsApp message preview</small>')
    .replace('This preview cannot send a message or record an order decision.', 'This local preview cannot send a message or perform an action.')
    .replace('</header>', scope + inventory + '</header>')
    .replace('Old uses the checked-in before-change source for direct templates; other Old notices are labelled representative. New shows the local revised draft. All values are dummy data. Nothing is sent.', 'Approved 12 October 2026. Email, fixed WhatsApp, web/mobile inbox and push previews. New shows the approved source version; Old uses verified source history. All examples use dummy data. Deployment status is reported separately in the chat.')
    .replace('<iframe id="preview"', '<iframe sandbox="" id="preview"')
    .replace(/<script id="preview-data" type="application\/json">[\s\S]*?<\/script>/, '<script id="preview-data" type="application/json">' + data + '</script>')
    .replace(/<script>[\s\S]*?<\/script><\/body><\/html>$/, '<script>' + script + '</script></body></html>');
}
module.exports = { sourceGalleryControls };
