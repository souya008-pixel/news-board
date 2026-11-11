// 画面のちらつきを防ぐため、保存済みの表示テーマを最初に適用する
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('nb:theme'));
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* 何もしない */ }
})();
