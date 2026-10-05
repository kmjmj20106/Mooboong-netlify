// Start the existing bootstrap request before the main UI and icon scripts run.
// No polling or extra personal-data prefetch; anonymous responses contain only setup state.
(() => {
  const route=location.hash.slice(1).split('/')[0];
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date=new Date(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-date.getUTCDay());
  const week=date.toISOString().slice(0,10);
  const promise=fetch('/api/bootstrap?'+new URLSearchParams({route,week}),{credentials:'same-origin',cache:'no-store'})
    .then(r=>r.ok?r.json():null).catch(()=>null);
  window.mooboongStartup={route,week,promise};
})();
