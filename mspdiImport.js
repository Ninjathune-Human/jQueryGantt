/*
 Import des fichiers XML MS Project (format MSPDI) dans jQueryGantt.
 Lit les tâches, la structure (niveaux), les jalons, l'avancement, les notes,
 les liens fin-début avec leur décalage, et le calendrier du projet (jours chômés).
 Tout se passe dans le navigateur : le fichier n'est envoyé nulle part.
 MIT, comme jQueryGantt.
*/
var MSPDI = (function () {

  function kids(el, name) {
    var r = [];
    if (!el) return r;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling)
      if (c.localName === name) r.push(c);
    return r;
  }

  function kid(el, name) {
    return kids(el, name)[0] || null;
  }

  function text(el, name, def) {
    var k = kid(el, name);
    return k ? k.textContent.trim() : def;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function dayKey(d) {
    return d.getFullYear() + "_" + pad(d.getMonth() + 1) + "_" + pad(d.getDate());
  }

  // "2027-02-01T08:00:00" -> date locale à minuit (l'heure est ignorée : jQueryGantt travaille en jours)
  function localDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // Calendrier du projet : jours de la semaine chômés et dates d'exception non travaillées
  function readCalendar(root, warnings) {
    var uid = text(root, "CalendarUID", "1"), cal = null;
    kids(kid(root, "Calendars"), "Calendar").forEach(function (c) {
      if (text(c, "UID") === uid) cal = c;
    });
    if (!cal) return null;

    var off = {0: true, 6: true}, dates = {}, recurring = 0;

    function addRange(tp) {
      var a = localDate(text(tp, "FromDate")), b = localDate(text(tp, "ToDate"));
      if (!a || !b) return;
      for (var d = a; d <= b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
        dates[dayKey(d)] = true;
    }

    kids(kid(cal, "WeekDays"), "WeekDay").forEach(function (w) {
      var type = +text(w, "DayType", "-1"), working = text(w, "DayWorking", "1") === "1";
      if (type >= 1 && type <= 7) { // 1 = dimanche ... 7 = samedi
        if (working) delete off[type - 1];
        else off[type - 1] = true;
      } else if (type === 0 && !working) {
        addRange(kid(w, "TimePeriod"));
      }
    });

    kids(kid(cal, "Exceptions"), "Exception").forEach(function (x) {
      if (text(x, "DayWorking", "0") !== "0") return;
      if (+text(x, "Occurrences", "1") > 1 && text(x, "Type", "1") !== "1") recurring++;
      else addRange(kid(x, "TimePeriod"));
    });

    if (recurring)
      warnings.push(recurring + " exception(s) récurrente(s) du calendrier ignorée(s)");

    return {name: text(cal, "Name", ""), off: off, dates: dates, count: Object.keys(dates).length};
  }

  // Remplace la règle des jours chômés de jQueryGantt (samedi et dimanche, sans fériés) par celle du fichier
  function installCalendar(cal) {
    window.isHoliday = function (date) {
      return cal.off[date.getDay()] === true || cal.dates[dayKey(date)] === true;
    };
  }

  function toProject(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, "application/xml");
    var root = doc.documentElement;
    if (!root || root.localName !== "Project" || doc.getElementsByTagName("parsererror").length)
      throw new Error("Ce fichier n'est pas un XML MS Project (format MSPDI).");

    var warnings = [];
    var minutesPerDay = +text(root, "MinutesPerDay", "480") || 480;
    var cal = readCalendar(root, warnings);
    if (cal) installCalendar(cal); // avant tout calcul de durée

    var src = kids(kid(root, "Tasks"), "Task").filter(function (t) {
      return text(t, "IsNull", "0") !== "1" && text(t, "Start", "") !== "";
    });
    if (!src.length) throw new Error("Le fichier ne contient aucune tâche.");

    var rows = src.map(function (t) {
      return {uid: text(t, "UID"), xml: t, level: +text(t, "OutlineLevel", "1")};
    });
    // jQueryGantt veut une tâche racine de niveau 0 : celle du fichier, ou une tâche « projet » créée ici
    if (rows[0].level !== 0)
      rows.unshift({uid: null, xml: null, level: 0});

    var rowByUid = {};
    rows.forEach(function (r, i) {
      if (r.uid !== null) rowByUid[r.uid] = i + 1;
    });

    var tasks = rows.map(function (r, i) {
      var t = r.xml, task = {
        id: -(i + 1), name: "", code: "", level: r.level, status: "STATUS_ACTIVE", depends: "",
        canWrite: true, startIsMilestone: false, endIsMilestone: false, collapsed: false,
        assigs: [], hasChild: i + 1 < rows.length && rows[i + 1].level > r.level,
        progress: 0, progressByWorklog: false, relevance: 0, type: "", typeId: "", description: ""
      };
      if (t) {
        var start = localDate(text(t, "Start")), finish = localDate(text(t, "Finish")) || start;
        var milestone = text(t, "Milestone", "0") === "1";
        task.name = text(t, "Name", "");
        task.code = text(t, "WBS", "");
        task.start = start.getTime();
        task.end = new Date(finish.getFullYear(), finish.getMonth(), finish.getDate(), 23, 59, 59, 999).getTime();
        task.startIsMilestone = milestone;
        task.endIsMilestone = milestone;
        task.progress = Math.round(+text(t, "PercentComplete", "0") || 0);
        task.description = text(t, "Notes", "");
        if (task.progress >= 100) task.status = "STATUS_DONE";
      }
      return task;
    });

    // Racine créée : nom et bornes du projet
    if (!rows[0].xml) {
      tasks[0].name = text(root, "Title", "") || text(root, "Name", "") || "Projet";
      tasks[0].start = Math.min.apply(null, tasks.slice(1).map(function (t) { return t.start; }));
      tasks[0].end = Math.max.apply(null, tasks.slice(1).map(function (t) { return t.end; }));
    }

    // Liens : jQueryGantt ne connaît que fin-début, avec un décalage positif en jours ouvrés
    var skippedType = 0, skippedLead = 0;
    rows.forEach(function (r, i) {
      if (!r.xml) return;
      var deps = [];
      kids(r.xml, "PredecessorLink").forEach(function (l) {
        var row = rowByUid[text(l, "PredecessorUID")];
        if (!row) return;
        if (text(l, "Type", "1") !== "1") { skippedType++; return; }
        var lag = Math.round((+text(l, "LinkLag", "0") || 0) / (minutesPerDay * 10)); // dixièmes de minute
        if (lag < 0) { skippedLead++; lag = 0; }
        deps.push(lag > 0 ? row + ":" + lag : String(row));
      });
      tasks[i].depends = deps.join(",");
    });
    if (skippedType) warnings.push(skippedType + " lien(s) autre(s) que fin-début non repris");
    if (skippedLead) warnings.push(skippedLead + " avance(s) négative(s) ramenée(s) à 0");

    tasks.forEach(function (t) {
      t.duration = getDurationInUnits(new Date(t.start), new Date(t.end));
    });

    return {
      project: {
        tasks: tasks, selectedRow: 0, deletedTaskIds: [], resources: [], roles: [],
        canWrite: true, canDelete: true, canWriteOnParent: true, canAdd: true
      },
      info: {
        title: text(root, "Title", "") || text(root, "Name", ""),
        tasks: tasks.length - 1, // hors tâche racine
        links: tasks.reduce(function (n, t) { return n + (t.depends ? t.depends.split(",").length : 0); }, 0),
        calendar: cal ? cal.name : "",
        holidays: cal ? cal.count : 0,
        warnings: warnings
      }
    };
  }

  return {toProject: toProject};
})();
