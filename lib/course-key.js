'use strict';
// Course package keys: the cache stem ("osm-relation-9892305"), URL- and file-safe.
// Pure (only course-identity), so the small cloud API on Vercel can use it without
// pulling in the course pipeline.

const { courseCacheStem, normalizeCourseSource } = require('./course-identity');

class CourseKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoursePackageError';
    this.code = code;
  }
}

function packageKeyFor(source) {
  return courseCacheStem(source);
}

// "osm-way-123" or "osm:way:123" -> normalized source.
function parsePackageKey(key) {
  const match = /^osm[-:](node|way|relation)[-:]([1-9][0-9]{0,15})$/.exec(String(key || ''));
  if (!match) throw new CourseKeyError('PACKAGE_KEY_INVALID', 'Course key must look like osm-way-123');
  try {
    return normalizeCourseSource({ osmType: match[1], osmId: Number(match[2]) });
  } catch (_) {
    throw new CourseKeyError('PACKAGE_KEY_INVALID', 'Course key must look like osm-way-123');
  }
}

module.exports = { packageKeyFor, parsePackageKey };
