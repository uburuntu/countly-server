const { getUserApps } = require('../../../api/utils/rights.js');

var plugins = require('../../pluginManager.js'),
    common = require('../../../api/utils/common.js'),
    countlyCommon = require('../../../api/lib/countly.common.js'),
    { validateUser } = require('../../../api/utils/rights.js'),
    stats = require('./parts/stats.js');

var log = common.log('data-points:api');

const FEATURE_NAME = 'server-stats';

(function() {

    plugins.register("/permissions/features", function(ob) {
        ob.features.push(FEATURE_NAME);
    });

    plugins.register("/master", function() {
        // Allow configs to load & scanner to find all jobs classes
        setTimeout(() => {
            require('../../../api/parts/jobs').job('server-stats:stats').replace().schedule('every 1 day');
        }, 10000);
    });

    /**
    * Register to all requests to /plugins/drill to catch all events
    * sent by plugins such as views and crashes
    * @returns {undefined} Returns nothing
    **/
    plugins.register("/plugins/drill", function(ob) {
        var eventCount = 0;

        if (ob.events && Array.isArray(ob.events)) {
            var events = ob.events;

            for (var i = 0; i < events.length; i++) {
                if (events[i].key) {
                    eventCount += 1;
                }
            }

            stats.updateDataPoints(common.writeBatcher, ob.params.app_id, 0, eventCount, stats.isConsolidated(ob.params));
        }
    });

    /**
    * Register to /sdk/end for requests that contain begin_session and events
    * @returns {boolean} Returns boolean, always true
    **/
    plugins.register("/sdk/data_ingestion", function(ob) {
        var params = ob.params,
            sessionCount = 0,
            eventCount = 0;

        if (!params.cancelRequest) {
            if (params.qstring.events && Array.isArray(params.qstring.events)) {
                var events = params.qstring.events;
                for (var i = 0; i < events.length; i++) {
                    if (events[i].key) {
                        eventCount += 1;
                    }
                }
            }
            // If the last end_session is received less than 15 seconds ago we will ignore
            // current begin_session request and mark this user as having an ongoing session
            var lastEndSession = params.app_user && params.app_user[common.dbUserMap.last_end_session_timestamp] || 0;

            if (params.qstring.begin_session && (params.qstring.ignore_cooldown || !lastEndSession || (params.time.timestamp - lastEndSession) > plugins.getConfig("api", params.app && params.app.plugins, true).session_cooldown)) {
                sessionCount++;
            }
            stats.updateDataPoints(common.writeBatcher, params.app_id, sessionCount, eventCount, stats.isConsolidated(params));
        }
        return true;
    });

    /**
    * Register to /i/server-stats/update-data-points
    * @param {{appId: string, sessionCount: number, eventCount: number}} ob - data points params
    **/
    plugins.register("/server-stats/update-data-points", function(ob) {
        const {appId, sessionCount, eventCount} = ob;
        stats.updateDataPoints(common.writeBatcher, appId, sessionCount, eventCount, stats.isConsolidated(ob));
    });

    /**
    * Collects requeriments for data selection for queries
    * @param {object} periodObj - period obj 
	* @param {array} periodsToFetch - list to collect month abbr strings
    * @param {object} dateObj  - object to collect info about date ranges
	* @param {string} period {string}  - period string
    **/
    function createDateObject(periodObj, periodsToFetch, dateObj, period) {
        var utcMoment;
        var mm;
        if (period === "month") {
            utcMoment = common.moment.utc(periodObj.start);
            var yy = utcMoment.format("YYYY");
            for (var k = 1; k <= 12; k++) {
                periodsToFetch.push(yy + ":" + k);
                dateObj[yy + ":" + k] = {"full": true};
            }
        }
        else if (period === "day") {
            utcMoment = common.moment.utc(periodObj.start);
            mm = utcMoment.format("YYYY:M");
            dateObj[mm] = {"full": true};
            periodsToFetch.push(mm);

        }
        else {
            for (var z = 0; z < periodObj.currentPeriodArr.length; z++) {
                mm = periodObj.currentPeriodArr[z].split(".");
                if (!dateObj[mm[0] + ":" + mm[1]]) {
                    dateObj[mm[0] + ":" + mm[1]] = {};
                }
                dateObj[mm[0] + ":" + mm[1]][mm[2]] = {"full": true};
            }
            for (var dd in dateObj) {
                periodsToFetch.push(dd);
            }
        }
    }

    /**
     * @api {get} /o/server-stats/data-points Get data points
     * @apiName initialize
     * @apiGroup DataPoints
     *
     * @apiDescription Returns last three month session, event and data point count for all and individual apps
     * @apiQuery {String} period array that contains start and end date as a timestamp. It also can be Countly period values which are:
     * {String} "yesterday" for yesterday's value,
     * {String} "hour" for today's value,
     * {String} "7days" for the last 7 days value,
     * {String} "30days" for the last 30days value,
     * {String} "60days" for the last 60days value,
     * {String} "day" for the all days current month value,
     * {String} "month" for all days from the first day of the first month to the last day of the last month of the current year
     * @apiQuery {String} selected_app selected app id of related application
     * 
     * @apiSuccessExample {json} Success-Response:
     * HTTP/1.1 200 OK
     *  {
     *      "all-apps": {
     *      "events": 234567,
     *      "sessions": 26252,
     *      "push": 0,
     *      "dp": 260819,
     *      "change": -895913
     *      },
     *      "61000642455b715cfc3c3d92": {
     *      "events": 127935,
     *      "push": 0,
     *      "sessions": 18087,
     *      "dp": 146022,
     *      "change": -888443
     *      },
     *      "610146fe455b715cfc3c46c4": {
     *      "events": 0,
     *      "push": 0,
     *      "sessions": 0,
     *      "dp": 0,
     *      "change": -20744
     *      }
     *  }
     * 
     * @apiErrorExample {json} Error-Response:
     * HTTP/1.1 400 Bad Request
     * {
     *  "result": "Missing parameter "api_key" or "auth_token""
     * }
    */
    plugins.register('/o/server-stats/data-points', function(ob) {
        var params = ob.params;
        var periodsToFetch = [];
        params.qstring.period = params.qstring.period || "30days";
        countlyCommon.setPeriod(params.qstring.period);
        var periodObj = countlyCommon.periodObj;
        var dateObj = {};
        createDateObject(periodObj, periodsToFetch, dateObj, params.qstring.period);
        var dateObjPrev = {};
        var singleApp = false;

        countlyCommon.setPeriod([periodObj.start - (periodObj.end - periodObj.start), periodObj.start - 1]);
        periodObj = countlyCommon.periodObj;
        createDateObject(periodObj, periodsToFetch, dateObjPrev, params.qstring.period);

        var filter = {
            _id: {$in: []}
        };

        validateUser(params, function() {
            if (!params.member.global_admin) {
                var apps = getUserApps(params.member) || [];
                for (let i = 0; i < periodsToFetch.length; i++) {
                    for (let j = 0; j < apps.length; j++) {
                        if (params.qstring.selected_app && params.qstring.selected_app !== "") {
                            singleApp = true;
                            if (apps[j] === params.qstring.selected_app) {
                                filter._id.$in.push(apps[j] + "_" + periodsToFetch[i]);
                            }
                        }
                        else {
                            if (apps[j] !== "") {
                                filter._id.$in.push(apps[j] + "_" + periodsToFetch[i]);
                            }
                        }
                    }
                }
                if (filter._id.$in.length) {
                    stats.fetchDatapoints(common.db, filter, {"dateObj": dateObj, "dateObjPrev": dateObjPrev}, function(toReturn) {
                        common.returnOutput(params, toReturn);
                    });
                }
                else {
                    return common.returnMessage(params, 401, 'User does not have apps');
                }
            }
            else {
                if (params.qstring.selected_app && params.qstring.selected_app !== "") {
                    singleApp = true;
                    filter._id = {"$in": []};
                    periodsToFetch.forEach((period) => {
                        filter._id.$in.push(`${params.qstring.selected_app}_${period}`);
                    });
                }
                else {
                    for (let i = 0; i < periodsToFetch.length; i++) {
                        filter._id.$in.push(new RegExp(".*_" + periodsToFetch[i]));
                    }
                }

                stats.fetchDatapoints(common.db, filter, {"dateObj": dateObj, "dateObjPrev": dateObjPrev, "singleApp": singleApp}, function(toReturn) {
                    common.returnOutput(params, toReturn);
                });
            }

        });

        return true;
    });

    /**
     * @api {get} /o/server-stats/data-points Get top one data of data points
     * @apiName calculateTop
     * @apiGroup DataPoints
     *
     * @apiDescription Calculate top one data points and return as an array.
     * 
     * @apiSuccessExample {json} Success-Response:
     * HTTP/1.1 200 OK
     *  [
     *      {
     *          "a": "6006df36fbe7200b7489137e",
     *          "v": 0
     *      }
     *  ]
     * 
     * @apiErrorExample {json} Error-Response:
     * HTTP/1.1 400 Bad Request
     * {
     *  "result": "Missing parameter "api_key" or "auth_token""
     * }
    */
    plugins.register("/o/server-stats/top", function(ob) {
        var params = ob.params;
        validateUser(params, async() => {
            stats.getTop(common.db, params, function(res) {
                common.returnOutput(params, res);
            });
        });
        return true;
    });

    /**
     * @api {get} /o/server-stats/punch-card Get punch card data
     * @apiName getPunchCardData
     * @apiGroup DataPoints
     *
     * @apiDescription Returns punch card data as a boolean, always true
     * @apiQuery {String} period array that contains start and end date as a timestamp. It also can be Countly period values which are:
     * {String} "yesterday" for yesterday's value,
     * {String} "hour" for today's value,
     * {String} "7days" for the last 7 days value,
     * {String} "30days" for the last 30days value,
     * {String} "60days" for the last 60days value,
     * {String} "day" for the all days current month value,
     * {String} "month" for all days from the first day of the first month to the last day of the last month of the current year
     * @apiQuery {String} selected_app selected app id of related application
     * 
     * @apiSuccessExample {json} Success-Response:
     * HTTP/1.1 200 OK
     *  {
     *  "data": [
     *      [
     *      0,
     *      0,
     *      0,
     *      {
     *          "min": null,
     *          "max": 0,
     *          "sum": 0,
     *          "avg": 0,
     *          "cn": 0,
     *          "p": 0,
     *          "s": 0,
     *          "e": 0
     *      }
     *      ],
     *      [
     *      1,
     *      0,
     *      0,
     *      {
     *          "min": null,
     *          "max": 0,
     *          "sum": 0,
     *          "avg": 0,
     *          "cn": 0,
     *          "p": 0,
     *          "s": 0,
     *          "e": 0
     *      }
     *      ]
     *  ],
     *  "dayCount": 1,
     *  "labels": [
     *      "2022.4.19"
     *  ]
     *  }
     * 
     * @apiErrorExample {json} Error-Response:
     * HTTP/1.1 400 Bad Request
     * {
     *  "result": "Missing parameter "api_key" or "auth_token""
     * }
    */
    plugins.register("/o/server-stats/punch-card", function(ob) {
        var params = ob.params;
        validateUser(params, async() => {
            var periodsToFetch = [];
            params.qstring.period = params.qstring.period || "30days";
            countlyCommon.setPeriod(params.qstring.period);
            var periodObj = countlyCommon.periodObj;
            var dateObj = {};
            createDateObject(periodObj, periodsToFetch, dateObj, params.qstring.period);

            try {
                let filter = {"m": {$in: periodsToFetch} };
                if (!params.member.global_admin) {
                    filter._id = {"$in": []};
                    const hasUserApps = getUserApps(params.member) || [];
                    if (params.qstring.selected_app) {
                        if (hasUserApps.indexOf(params.qstring.selected_app) > -1) {
                            periodsToFetch.forEach((period) => {
                                filter._id.$in.push(`${params.qstring.selected_app}_${period}`);
                            });
                        }
                        else {
                            //access denied
                        }
                    }
                    else {
                        hasUserApps.forEach((id) => {
                            periodsToFetch.forEach((period) => {
                                filter._id.$in.push(`${id}_${period}`);
                            });
                        });
                    }
                }
                else {
                    if (params.qstring.selected_app) {
                        filter._id = {"$in": []};
                        periodsToFetch.forEach((period) => {
                            filter._id.$in.push(`${params.qstring.selected_app}_${period}`);
                        });
                    }
                }
                const _punchCard = await stats.punchCard(common.db, filter, {dateObj: dateObj, periodObj: periodObj});
                common.returnOutput(params, _punchCard);
            }
            catch (error) {
                log.e("Error while fetching punch card data: ", error.message);
                common.returnMessage(params, 400, "Something went wrong");
            }
        });
        return true;
    });
}());

