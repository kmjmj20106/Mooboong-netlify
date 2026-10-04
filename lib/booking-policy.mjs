export function reservationPolicy(settings,date,{memberId,teamId,type,session=''}) {
  const special=settings.specialPolicy;
  const active=Boolean(special?.enabled&&date>=special.from&&date<=special.until);
  let hours=type==='team'?settings.teamWeeklyHours:settings.personalWeeklyHours;
  if(active)hours=type==='team'?special.teamWeeklyHours:special.personalWeeklyHours;
  const overrides=settings.quotaOverrides||[];
  const override=overrides.find(r=>r.type===type&&String(r.id)===String(type==='team'?teamId:memberId)&&date>=r.from&&date<=r.until);
  if(override)hours=override.hours;
  const sessions=String(session).split(/[,/·\s]+/).filter(Boolean);
  const allowed=!active||type!=='personal'||!special.allowedSessions.length||special.allowedSessions.some(s=>sessions.includes(s));
  return {hours,allowed,active};
}
export function validatePolicies(body,validDate,fail){
  const hours=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=40&&Number.isInteger(v*2);
  if(body.specialPolicy!==undefined){
    const p=body.specialPolicy;
    if(!p||typeof p.enabled!=='boolean'||!Array.isArray(p.allowedSessions)||p.allowedSessions.length>20||p.allowedSessions.some(s=>typeof s!=='string'||!s.trim()||s.length>100)||!hours(p.personalWeeklyHours)||!hours(p.teamWeeklyHours))fail(400,'특별 규칙의 세션과 시간 한도를 확인해 주세요.');
    if((p.enabled||p.from||p.until)&&(!validDate(p.from)||!validDate(p.until)||p.until<p.from))fail(400,'특별 규칙의 시작일과 종료일을 확인해 주세요.');
  }
  if(body.quotaOverrides!==undefined){
    if(!Array.isArray(body.quotaOverrides)||body.quotaOverrides.length>200)fail(400,'개별 한도는 최대 200개입니다.');
    const rows=body.quotaOverrides;
    for(let i=0;i<rows.length;i++){
      const r=rows[i];
      if(!r||!['personal','team'].includes(r.type)||typeof r.id!=='string'||!r.id||r.id.length>100||(r.type==='team'&&!/^[1-9]\d*$/.test(r.id))||!validDate(r.from)||!validDate(r.until)||r.until<r.from||!hours(r.hours))fail(400,'개별 한도의 대상·기간·시간을 확인해 주세요.');
      if(rows.slice(0,i).some(x=>x.type===r.type&&x.id===r.id&&x.from<=r.until&&x.until>=r.from))fail(400,'같은 대상의 개별 한도 기간은 겹칠 수 없습니다.');
    }
  }
}
