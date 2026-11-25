/* Проверки на локальном стенде tests/mock_cloud.py. Два аккаунта и два независимых хранилища браузера. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { BASE, DESK, PHONE, launch, openPage, login, mock, rows } = require('./lib');
const archiveSeed = require('../data/archive.json');

async function until(read, label) {
  for (let i=0; i<70; i++) {
    if (await read()) return;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(label);
}
async function card(page,game,id,overlay=false) {
  await page.evaluate(([game,id,overlay])=>{
    if(CUR_PROJECT!==game) setProject(game);
    if(!overlay) go('world');
    openModal(id,overlay);
  },[game,id,overlay]);
  const entry=page.locator('.ar-card[data-entry="'+id+'"]:visible').last();
  await entry.waitFor();
  return entry;
}
async function checkOpenText(details,label) {
  await details.locator(':scope > summary').click();
  const gaps=await details.evaluate(box=>{
    const textLines=[];
    for(const paragraph of box.querySelectorAll('.ar-prose p')){
      const range=document.createRange();
      range.selectNodeContents(paragraph);
      for(const r of range.getClientRects())if(r.width&&r.height)textLines.push(r);
    }
    if(!box.open||!textLines.length)return null;
    const frame=box.getBoundingClientRect(),heading=box.querySelector('summary').getBoundingClientRect();
    return {
      left:Math.min(...textLines.map(r=>r.left-frame.left)),
      right:Math.min(...textLines.map(r=>frame.right-r.right)),
      top:Math.min(...textLines.map(r=>r.top-heading.bottom)),
      bottom:Math.min(...textLines.map(r=>frame.bottom-r.bottom))
    };
  });
  assert(gaps,label+' — раскрытый текст виден');
  assert(gaps.left>=8&&gaps.right>=8&&gaps.bottom>=8&&gaps.top>=-1,label+' — отступы текста в пикселях '+JSON.stringify(gaps));
}
async function verifyDisclosureLayout(page,width) {
  const barbarian=await card(page,'classic','srd-varvar');
  assert.equal(await barbarian.evaluate(el=>el.closest('#readerBody,#modal').id),width===DESK.width?'readerBody':'modal');
  const attack=barbarian.locator('details.sec').filter({has:page.locator('summary',{hasText:'Безрассудная атака'})});
  await checkOpenText(attack,'Варвар, Безрассудная атака, '+width);

  const wizard=await card(page,'classic','srd-volshebnik',true);
  assert.equal(await wizard.evaluate(el=>el.closest('#modal2').id),'modal2');
  const feature=wizard.locator('details.sec').filter({has:page.locator('summary',{hasText:'Использование заклинаний'})}).first();
  await checkOpenText(feature,'Волшебник поверх карточки, '+width);
  const scroll=await wizard.locator('.lvl-wrap').evaluate(el=>{
    const wrap=el.getBoundingClientRect(),card=el.closest('.ar-card'),frame=card.getBoundingClientRect();
    el.scrollLeft=el.scrollWidth;
    return {fits:wrap.left>=frame.left-1&&wrap.right<=frame.right+1&&card.scrollWidth<=card.clientWidth+1,
      wide:el.scrollWidth>el.clientWidth+1,moved:el.scrollLeft>0};
  });
  assert(scroll.fits,'Таблица ячеек волшебника должна оставаться в карточке, '+width);
  if(width<=PHONE.width)assert(scroll.wide&&scroll.moved,'Широкая таблица должна прокручиваться внутри карточки, '+width);
  await page.evaluate(()=>{closeOverlay();closeModal();});
}
async function verifyCards(page) {
  await page.evaluate(()=>{setProject('classic');return parseBestiary();});
  await page.waitForFunction(()=>ARCHIVE.some(x=>x.id==='srd-goblin'));
  for(const size of [DESK,PHONE,{width:320,height:700}]) {
    await page.setViewportSize(size);
    await verifyDisclosureLayout(page,size.width);
    const carpet=await card(page,'classic','srd-kover-samolet');
    for(const [weight,speed] of [[200,'80 футов'],[201,'40 футов'],[400,'40 футов'],[401,'Не поднимет']]){
      await carpet.locator('input[data-ar=load]').fill(String(weight));
      assert.equal(await carpet.locator('tbody tr').first().locator('td').last().textContent(),speed);
    }
    assert(await carpet.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'горизонтальная прокрутка самой карточки');
    const ice=await card(page,'classic','sp-ice-knife');
    await ice.locator('[data-ar=slot]').selectOption('9');
    assert.match(await ice.locator('tbody').textContent(),/1к10 колющего \+ 10к6 холодом/);
    assert.match(await ice.locator('tbody').textContent(),/ПромахБез урона10к6 холодом/);
    assert(await ice.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    if(process.env.TEST_EVIDENCE && size.width===390)await page.screenshot({animations:'disabled',path:path.join(process.env.TEST_EVIDENCE,'archive-spell-phone.png')});
    await checkOpenText(ice.locator('details.ar-details').filter({has:page.getByText('Полный текст заклинания',{exact:true})}),'Полный текст заклинания, '+size.width);
    const goblin=await card(page,'classic','srd-goblin');
    await goblin.locator('[data-ar=damage]').selectOption('dice');
    assert.equal(await goblin.locator('.ar-attacks tbody tr').count(),2);
    assert.match(await goblin.locator('.ar-attacks tbody').textContent(),/1к6\+2/);
    assert.match(await goblin.locator('.ar-stats').textContent(),/15.*7.*30.*1\/4/);
    if(process.env.TEST_EVIDENCE && size.width===1440)await page.screenshot({animations:'disabled',path:path.join(process.env.TEST_EVIDENCE,'archive-goblin-desktop.png')});
    await checkOpenText(goblin.locator('details.ar-details').filter({has:page.getByText('Полный текст атак',{exact:true})}),'Текст атак существа, '+size.width);
    assert.match(await goblin.locator('details[open]').innerText(),/Скимитар/);
    await page.evaluate(()=>closeModal());
  }
  const injuries=await card(page,'terra','cmsxibx0x');
  for(const n of [15,18,20]){
    await injuries.locator('[data-ar-roll="'+n+'"]').click();
    assert.match(await injuries.locator('output').textContent(),n===20?/Потеря Пальца/i:/В карточке не указано/);
  }
  const city=await card(page,'legacy','cms2q5rxb');
  assert.equal(await city.locator('.sec li').count(),6);
  assert.match(await city.locator('.body').textContent(),/Свободного совета/);
  await city.getByText('Описание из Архива',{exact:true}).click();
  assert.match(await city.locator('.body details').innerText(),/родину/);
  const wizard=await card(page,'classic','srd-volshebnik');
  await wizard.locator('[data-ar=level]').selectOption('2');
  assert.equal(await wizard.locator('.lvl-tbl tbody tr:visible').count(),1);
  assert.equal(await wizard.locator('.lvl-tbl tbody tr:visible .lv').textContent(),'2');
  const tp=await card(page,'classic','srd-teleportaciya');
  await tp.locator('[data-ar=row]').selectOption('6');
  assert.match(await tp.locator('tbody tr:visible').innerText(),/51-100/);
  const shield=await card(page,'classic','srd-schit');
  await shield.getByText('Сравнить с другим предметом',{exact:true}).click();
  await shield.locator('[data-ar=compare]').selectOption('srd-kolchuga');
  assert.match(await shield.locator('[data-ar-comparison]').innerText(),/Кольчуга/);
  assert.match(await shield.innerText(),/Бонусы от нескольких щитов не складываются/);
  const exhaustion=await card(page,'classic','srd-istoschenie-urovni');
  await exhaustion.locator('[data-ar=exhaustion]').selectOption('3');
  assert.equal(await exhaustion.locator('tbody tr:visible').count(),3);
  assert.match(await exhaustion.innerText(),/с едой и питьём/);
  const counters=await page.evaluate(async()=>{
    const source=JSON.parse(JSON.stringify(ARCHIVE));
    const test=document.createElement('div');
    let count=0;
    for(const e of source){
      for(const sec of e.sections||[]){
        if(!sec.t?.includes(' — '))continue;
        const html=archiveView.prose(sec.t,e,sec.h);
        if(html.includes('class="ar-table"')){test.innerHTML=html;count+=test.querySelectorAll('.ar-table').length;}
      }
    }
    const complex={sub:'bestiary',sections:[{h:'Действие · Особое',t:'Рукопашная атака оружием: +4 к попаданию, досягаемость 5 фт., одна цель. Попадание: 5 (1к6+2) рубящего урона. Дополнительный эффект.'}]};
    const air=ARCHIVE_ALL.assimilation.find(e=>e.id==='as-vozduh');
    if(air){test.innerHTML=archiveView.air(air); document.body.appendChild(test);
      const choose=(key,v)=>{const s=test.querySelector('[data-ar='+key+']');s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));};
      choose('air','5');choose('protection','2');if(!test.querySelector('output').textContent.startsWith('3 ·'))throw Error('ступень воздуха');
      choose('protection','1');if(!test.querySelector('output').textContent.startsWith('4 ·'))throw Error('имплант');test.remove();}
    return {count,complex:archiveView.attacks(complex),air:!!air};
  });
  assert(counters.count>=40);assert.equal(counters.complex,null);assert(counters.air);
  for(const game of ['assimilation','neverland','gw','skazki']){
    const id=await page.evaluate(game=>{
      setProject(game);
      if(game==='assimilation') return 'as-vozduh';
      if(game==='skazki'){
        const alias=ARCHIVE.find(e=>e.dossier?.some(r=>r.k==='В каноне'));
        if(!alias || !secHay(alias).includes(searchNorm(alias.dossier.find(r=>r.k==='В каноне').v)))throw Error('поиск канонического названия');
        return alias.id;
      }
      return (ARCHIVE.find(e=>e.srcbook==='HB')||ARCHIVE[0]).id;
    },game);
    assert(await (await card(page,game,id)).locator('h2').first().isVisible());
    const modal=page.locator('#scrim.open');
    if(await modal.count()){
      await modal.getByRole('button',{name:'Закрыть',exact:true}).click();
      await modal.waitFor({state:'hidden'});
    }
  }
  console.log('Карточки на 320, 390 и 1440 px. Таблиц в доступных разделах классики:',counters.count);
}
async function sync(player,gm) {
  const id='archive-check-pc', spell='sp-ice-knife', beast='srd-goblin';
  await player.evaluate(async([id,spell])=>{
    setProject('classic'); const now=Date.now();
    CHARS_ALL.classic.push({id,name:'Кира',owner:currentTag(),role:'Волшебник',cfeats:'Использование заклинаний',hp:'12',ac:'13',level:1,createdAt:now,updatedAt:now,
      slots:{'1':{max:2,used:0}},spellcasting:{cls:['Волшебник'],lvls:{'Волшебник':1},known:[spell],prep:[spell]}});
    bindGameData(); await persistChars();
  },[id,spell]);
  const sheet=async()=>((await rows())['comik:chars:testplayer']?.classic||[]).find(x=>x.id===id);
  await until(async()=>(await sheet())?.spellcasting?.known?.includes(spell),'лист игрока не дошёл до стенда');
  const initial=await sheet();
  await gm.bringToFront();
  await gm.evaluate(async()=>{setProject('classic');await parseBestiary();go('combat');});
  await until(async()=>gm.evaluate(async id=>{await cloudTickOnce();return CHARS_ALL.classic.some(x=>x.id===id);},id),'мастер не получил персонажа');
  await gm.waitForFunction(()=>ARCHIVE.some(e=>e.id==='srd-goblin'));
  await gm.evaluate(([id,beast])=>{trkLoad();trkAddChar(id);trkAddBeast(beast);trkToggleActive();},[id,beast]);
  const board=async()=>((await rows())['comik:tracker:shared:v1']||{})['classic::hinoma'];
  await until(async()=>{const b=await board();return b?.active&&b.list.some(x=>x.charId===id)&&b.list.some(x=>x.srcId===beast&&x.hp===7);},'мастер не опубликовал состав');
  await player.evaluate(()=>{go('combat');return trkLiveCatchup(true);});
  await until(async()=>player.evaluate(async id=>{await trkFetchShared(true);return playerMyCard(trkActiveForPlayer())?.charId===id;},id),'игрок не увидел свой стол');
  await player.evaluate(id=>{go('players');openPlayer(id);},id);
  await player.locator('#modal').getByRole('button',{name:/Использование заклинаний/}).click();
  const openedFeature=player.locator('#modal2 [data-entry="srd-volshebnik"] details.sec[open]').filter({has:player.locator('summary',{hasText:'Использование заклинаний'})});
  await openedFeature.locator('.ar-prose p').first().waitFor();
  await player.evaluate(id=>{closeOverlay();closeModal();openInlineSheet(id,null,false);},id);
  const link=player.locator('#playerEditor [onclick*="sp-ice-knife"][onclick*="openModal"]').first();
  await link.evaluate(el=>el.click());
  const overlay=player.locator('#modal2 .ar-card[data-entry="'+spell+'"]');
  await overlay.locator('[data-ar=slot]').selectOption('7');
  await gm.evaluate(id=>trkApplyHp(TRK.list.findIndex(x=>x.charId===id),8,0),id);
  await until(async()=>player.evaluate(async id=>{await trkFetchShared(true);return playerMyCard(trkActiveForPlayer())?.hp===8;},id),'изменение хитов мастером не пришло игроку');
  assert.equal(await overlay.locator('[data-ar=slot]').inputValue(),'7');
  await player.evaluate(()=>closeOverlay());
  await player.evaluate(id=>trkPlayerHpSet(id,10),id);
  await until(async()=>gm.evaluate(async id=>{await trkFetchShared(true);return TRK_SHARED[gmBoardKey()]?.list.find(x=>x.charId===id)?.hp===10;},id),'мастер не увидел ответ игрока');
  const after=await sheet();assert.deepEqual(after.spellcasting,initial.spellcasting);assert.deepEqual(after.slots,initial.slots);
  assert.equal(after.hp,initial.hp);assert.equal(after.owner,initial.owner);
  const actor=(await board()).list.find(x=>x.srcId===beast); assert.equal(actor.hp,7);assert.equal(Number(actor.ac),15);
  console.log('Два клиента: лист → доска, заклинание поверх листа, хиты 12 → 8 → 10, ячейки и подготовка сохранены');
}
(async()=>{
  assert(['localhost','127.0.0.1'].includes(new URL(BASE).hostname),'нужен локальный тестовый стенд');
  const seed=await mock('/__mock/rows');
  await mock('/__mock/rows','POST',[...seed.filter(r=>r.key!=='comik:archive:v1'),{key:'comik:archive:v1',value:archiveSeed}]);
  const browser=await launch();
  try{
    const opts={project:'classic',storage:{'comik:cookies:ok':'1','comik:hint:setting':'1'}};
    const gm=await openPage(browser, opts), player=await openPage(browser, opts);
    await login(gm.page,'hinoma');await login(player.page,'testplayer');
    await verifyCards(gm.page);
    await sync(player.page,gm.page);
    assert.deepEqual([...gm.errs,...player.errs],[]);
    console.log('ИТОГ: карточки Архива и связка листа с доской проверены');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
