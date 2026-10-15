sap.ui.define([
  "sap/fe/core/PageController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/format/DateFormat"
], function (PageController, JSONModel, MessageToast, MessageBox, DateFormat) {
  "use strict";

  var PERIOD_TEXT = { "1H": "Last hour", "24H": "Last 24 hours", "7D": "Last 7 days", "30D": "Last 30 days" };
  var REFRESH_SECONDS = 30;

  var fmtHour = DateFormat.getDateTimeInstance({ pattern: "HH:mm" });
  var fmtDay = DateFormat.getDateInstance({ pattern: "EEE dd.MM" });
  var fmtRel = DateFormat.getDateTimeInstance({ relative: true, relativeScale: "auto", style: "short" });

  // ?period=7D in the URL preselects the period (used by the Joule agent link).
  function initialPeriod() {
    var match = /[?&]period=(1H|24H|7D|30D)/i.exec(window.location.href);
    return match ? match[1].toUpperCase() : "7D";
  }

  return PageController.extend("job.monitor.ext.main.Main", {

    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments);
      var period = initialPeriod();
      this._ui = new JSONModel({
        period: period,
        periodText: PERIOD_TEXT[period],
        autoRefresh: true,
        refreshSeconds: REFRESH_SECONDS,
        syncing: false,
        kpi: { total: 0, success: 0, error: 0, warning: 0, inProcess: 0, successRate: 0 },
        lastSyncText: "",
        trend: [],
        byJob: [],
        topErrors: []
      });
      this.getView().setModel(this._ui, "ui");
      this._initCharts();
      this._startTimer();
    },

    onAfterRendering: function () {
      if (!this._loadedOnce) {
        this._loadedOnce = true;
        this._loadDashboard();
        // Default list view: failed runs only.
        this._applyFilter("statusGroup", ["Error"], true);
      }
    },

    onExit: function () { this._stopTimer(); },

    // ------------------------------------------------------------------ data
    _serviceUrl: function () {
      var oModel = this.getView().getModel() || this.getAppComponent().getModel();
      return oModel.getServiceUrl();
    },

    _call: function (fn) {
      var period = this._ui.getProperty("/period");
      return fetch(this._serviceUrl() + fn + "(period='" + period + "')", {
        headers: { Accept: "application/json" }, credentials: "include"
      }).then(function (r) {
        if (!r.ok) { throw new Error(fn + " failed: HTTP " + r.status); }
        return r.json();
      });
    },

    _loadDashboard: function () {
      var that = this;
      var period = this._ui.getProperty("/period");
      return Promise.all([
        this._call("getKpis"), this._call("getTrend"), this._call("getByJob"), this._call("getTopErrors")
      ]).then(function (res) {
        var kpi = res[0];
        that._ui.setProperty("/kpi", kpi);
        that._ui.setProperty("/lastSyncText", kpi.lastSyncAt ? fmtRel.format(new Date(kpi.lastSyncAt)) : "");
        var fmt = period === "7D" || period === "30D" ? fmtDay : fmtHour;
        that._ui.setProperty("/trend", (res[1].value || []).map(function (p) {
          // buckets are UTC: "YYYY-MM-DD", "YYYY-MM-DDTHH:00" or "YYYY-MM-DDTHH:MM"
          var d = new Date(p.bucket.length === 10 ? p.bucket + "T00:00:00Z" : p.bucket + ":00Z");
          return Object.assign({ label: fmt.format(d) }, p);
        }));
        that._ui.setProperty("/byJob", (res[2].value || []).map(function (j) {
          var name = j.jobName || "";
          return Object.assign({}, j, { jobName: name.length > 45 ? name.slice(0, 44) + "…" : name, fullName: name });
        }));
        that._ui.setProperty("/topErrors", res[3].value || []);
      }).catch(function (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        MessageToast.show("Could not load dashboard data: " + e.message);
      });
    },

    _refreshTable: function () {
      var oModel = this.getView().getModel();
      if (oModel) { oModel.refresh(); }
    },

    // -------------------------------------------------------------- events
    onRefresh: function () {
      this._loadDashboard();
      this._refreshTable();
    },

    onPeriodChange: function (oEvent) {
      var key = oEvent.getParameter("item").getKey();
      this._ui.setProperty("/period", key);
      this._ui.setProperty("/periodText", PERIOD_TEXT[key]);
      this._loadDashboard();
    },

    onAutoRefreshToggle: function (oEvent) {
      if (oEvent.getParameter("state")) { this._startTimer(); } else { this._stopTimer(); }
    },

    onSyncNow: function () {
      var that = this;
      this._ui.setProperty("/syncing", true);
      var oAction = this.getView().getModel().bindContext("/syncNow(...)");
      oAction.execute().then(function () {
        var run = oAction.getBoundContext().getObject();
        if (run && run.success === false) {
          MessageBox.error(run.message || "Sync failed", { title: "Cloud ALM sync failed" });
        } else {
          MessageToast.show(run && run.message ? run.message : "Sync completed");
        }
        that.onRefresh();
      }).catch(function (e) {
        MessageBox.error(e.message, { title: "Cloud ALM sync failed" });
      }).finally(function () {
        that._ui.setProperty("/syncing", false);
      });
    },

    /** KPI tile -> filter the job list by processing state */
    onTilePress: function (oEvent) {
      var group = oEvent.getSource().data("group");
      this._applyFilter("statusGroup", group ? [group] : []);
    },

    onJobSelect: function (oEvent) {
      var d = oEvent.getParameter("data");
      var label = d && d[0] && d[0].data.Job;
      if (!label) { return; }
      var entry = (this._ui.getProperty("/byJob") || []).find(function (j) { return j.jobName === label; });
      this._applyFilter("jobName", [entry ? entry.fullName : label]);
    },

    onTopErrorPress: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("ui").getObject();
      this._applyFilter("statusGroup", ["Error"]);
      this._applyFilter("jobName", [o.jobName]);
    },

    _applyFilter: function (property, values, silent) {
      var oFilterBar = this.byId("FilterBar");
      if (!oFilterBar) { return; }
      Promise.resolve(oFilterBar.setFilterValues(property, "EQ", values)).then(function () {
        return oFilterBar.triggerSearch && oFilterBar.triggerSearch();
      });
      var oTable = this.byId("JobTable");
      if (!silent && oTable && oTable.getDomRef()) { oTable.getDomRef().scrollIntoView({ behavior: "smooth", block: "start" }); }
    },

    // ------------------------------------------------------------- helpers
    _startTimer: function () {
      var that = this;
      this._stopTimer();
      this._timer = setInterval(function () {
        if (that._ui.getProperty("/autoRefresh") && !document.hidden) { that.onRefresh(); }
      }, REFRESH_SECONDS * 1000);
    },

    _stopTimer: function () {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    _initCharts: function () {
      var colors = ["#36a41d", "#e76500", "#d20a0a", "#a9b4be"]; // success, warning, error, in process
      var common = {
        title: { visible: false },
        legend: { visible: true },
        legendGroup: { layout: { position: "bottom" } },
        valueAxis: { title: { visible: false } },
        categoryAxis: { title: { visible: false } },
        plotArea: { colorPalette: colors, dataLabel: { visible: false } },
        interaction: { selectability: { mode: "single" } }
      };
      ["trendChart", "jobChart"].forEach(function (id) {
        var c = this.byId(id);
        if (c) { c.setVizProperties(common); }
      }.bind(this));
    }
  });
});
