// UI auth helpers (solo frontend).
// - Usa sessionStorage para que al cerrar el navegador se cierre la sesión.
// - Botón "Salir" en cualquier página (con confirmación).
(function(){
  function doLogout(){
    var ok = window.confirm("¿Seguro que quieres salir? Los cambios no guardados se perderán.");
    if(!ok) return;
    try{
      sessionStorage.removeItem("usuario");
      sessionStorage.removeItem("rol");
      // compatibilidad: limpia posibles restos antiguos
      localStorage.removeItem("usuario");
      localStorage.removeItem("rol");
    }catch(e){}
    // vuelve al login (raíz) y recarga
    window.location.href = "/";
  }

  // expone función global por compatibilidad con onclick="logout()"
  window.logout = doLogout;

  // robusto: cualquier elemento con data-logout
  document.addEventListener("click", function(ev){
    var el = ev.target;
    if(!el) return;
    var btn = el.closest && el.closest("[data-logout]");
    if(btn){
      ev.preventDefault();
      doLogout();
    }
  });
})();