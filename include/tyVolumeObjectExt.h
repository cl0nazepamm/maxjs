/*Copyright (c) 2026, Tyson Ibele Productions Inc.
All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this file ("tyVolumeObjectExt.h") and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom
the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

#pragma once

// headers from Max SDK

#include "object.h"

#if MAX_RELEASE < 25000
#include "box3.h"
#include "matrix3.h"
#include "point2.h"
#include "point3.h"
#include "point4.h"
#else
#include "Geom/box3.h"
#include "Geom/matrix3.h"
#include "Geom/point2.h"
#include "Geom/point3.h"
#include "Geom/point4.h"	
#endif

#define TYVOLUME_INTERFACE_V1 Interface_ID (0x1213b15, 0x1e23513)
#define TYVOLUME_INTERFACE_V2 Interface_ID (0x1213b16, 0x1e23514)
#define TYVOLUME_INTERFACE_V3 Interface_ID (0x1213b17, 0x1e23515)

/*

tyVolumeObjectExt (v1) CHANGELOG:

03/25/2026:

* added tyVolume_v2 and TYVOLUME_INTERFACE_V3 with new functions to 
  return fuel color and raymarching step size

03/10/2026:

* added TYVOLUME_INTERFACE_V2 with new function to check if 
  volumes changed by user since last call to UpdateVolumes

09/26/2025:

* fixed incorrect Interface_ID
* fixed includes for Max 2023+

05/20/2024:

* initial creation of basic volume interface

*/

namespace tyFlow
{
	/*
	A wrapper class containing all relevant properties and
	accessor functions for a given volume.
	*/
	class tyVolume_v1
	{
	public:
		enum ScalarType : int
		{
			density,
			fuel,
			temperature,
		};

		enum VectorType : int
		{
			color,
			velocity,
		};

		/*
		The world-space transform of the volume, relative
		to its zero-th voxel coordinate.
		*/
		Matrix3 transform;

		/*
		The number of voxels the volume contains
		along each X/Y/Z axis. The total number of
		voxels for a given volume is:
		dimensions.x * dimensions.y * dimensions.z
		*/
		IPoint3 dimensions;

		/*
		Accessor functions and enums which allow you to query
		per-voxel volume values, given a volume-local XYZ coordinate
		and a voxel data type.
		Fractional coordinates will be trilinear interpolated.
		*/
		virtual float GetScalar(const Point3 xyz, const ScalarType type) = 0;
		virtual Point3 GetVector(const Point3 xyz, const VectorType type) = 0;

		/*
		Accessor functions which allow you to query fire display
		values, that match tyFlow's own viewport display of
		volume fire. By passing a temperature value (obtained
		through the GetScalar function), fire opacity/color
		values will be returned, which correspond to the fire
		opacity/color gradients assigned in tyFlow's volume
		display UI.
		Color values are not clamped and may have xyz components
		greater than 1, depending on the fire color intensity
		value assigned in tyFlow's volume display UI.
		*/
		virtual float GetFireOpacity(const float temperature) = 0;
		virtual Point3 GetFireColor(const float temperature) = 0;

		/*
		Accessor functions which allow you to query per-volume
		opacity multipliers, assigned in tyFlow's volume display UI.
		These multipliers should be applied uniformly to all
		voxels in the volume.
		*/
		virtual float GetDensityOpacityMultiplier() = 0;
		virtual float GetFuelOpacityMultiplier() = 0;
		virtual float GetOverallOpacityMultiplier() = 0;

		/*
		Helper function to return this volume's
		logical coordinates, relative to the local parent
		interface origin (the inverse transform of the first
		volume returned by the parent interface).

		The validity of logical coordinates is dependent
		on the following three volume interface axioms:

		(1) All volumes returned by a particular
		volume interface have the same scale and voxel dimensions.

		(2) No two volumes returned by a particular volume
		interface will share the same world-space transform.

		(3) All volume local-interface-coordinates
		are evenly-divisible by their dimensions.

		These axioms entail that all volumes returned
		by a particular interface will be the same size, and be
		non-overlapping.

		Given these axioms, it's easy to calculate logical
		coordinates for a volume, using the following
		formula:

		Point3 logicalCoordinate =
		(
				volume->transform *
				Inverse(interface->GetVolume(0)->transform)
		).GetTrans() / volume->dimensions;

		So, the logical coordinates of the first volume
		returned by a volume interface would be [0,0,0].
		A volume immediately adjacent to the right of
		the first volume would have logical coordinates
		of [1,0,0]. A volume immediately adjacent to the
		top of that volume would have logical coordinates
		of [1,0,1], and so on.

		Because the logical coordinates of volumes can be
		hashed in a fewer number of bits than regular world-space
		coorindates, they are optimal candidates for spatial
		hashing structures which may be used to accelerate
		world-space-to-volume lookups. You can also use
		logical coordinates to quickly query an interface for
		the neighbor volumes of a particular volume, when doing
		things like trilinear interpolation. Ex:

		//get neighbor to the right of this volume, if it exists
		tyVolume* neighborVolume =
		interface->GetVolume(volume->GetLogicalCoordinates() +
		IPoint3(1,0,0));
		*/
		virtual IPoint3 GetLogicalCoordinates() = 0;
	};

	class tyVolume_v2 : public tyVolume_v1
	{
	public:

		/*
		Accessor function which allows you to query fuel display
		color, that matches tyFlow's own viewport display of
		volume fuel. Fuel color is the same for all voxels containing
		fuel values.
		*/
		virtual Point3 GetFuelColor() = 0;
	};

	/*
	The tyVolumeObjectExt interface class can be used to access
	a tyFlow object's volume data.
	*/
	class tyVolumeObjectExt_v1
	{
	public:
		/*
		This function prepares tyFlow volumes for API access and
		should be called on a per-frame basis prior to calling any
		other volume API functions.

		The plugin argument of this function takes the name of the
		plugin querying this interface, in lowercase letters.
		Ex: _T("arnold"), _T("redshift"), _T("vray"), etc. This is
		a somewhat arbitrary value, but by having plugins identify
		themselves during a query, tyFlow can internally determine
		if any plugin-specific edge-cases need to be processed.

		If you pass "debug" as the plugin name, a set of debug
		volumes will be generated, whose combined densities form
		a sphere at the world origin, with interpolated RGB coloring.
		This mode can be  useful for sanity-checking code that
		references this interface. A point-based preview of this
		data can be displayed in the viewport by enabling "Display
		volume debug data" in the "Debugging" rollout of any
		tyFlow object.
		*/
		virtual void UpdateVolumes(const TimeValue t, const TSTR plugin) = 0;

		/*
		Developers should call this once they are done processing
		tyFlow volume data, to clear any internal allocations that
		may have been made during the prior call to UpdateVolumes.
		*/
		virtual void ReleaseVolumes() = 0;

		/*
		Returns the total number of volumes available. Depending on
		the complexity of sparse simulation data exposed by this
		interface, the number of volumes returned may be in the
		tens of thousands. All tyVolume accessor functions are
		thread-safe, so multi-threaded processing of these volumes
		is recommended.
		*/
		virtual int NumVolumes() = 0;

		/*
		Returns a tyVolume by index (range: 0 - [NumVolumes()-1]).
		The interface retains ownership of these pointers and
		cleans them up in the call to ReleaseVolumes().
		*/
		virtual tyVolume_v1* GetVolume(const int index) = 0;

		/*
		Returns the tyVolume (if it exists, otherwise NULL) located
		at the specified logical coordinate point, as well as
		its interface index.
		The interface retains ownership of these pointers and
		cleans them up in the call to ReleaseVolumes().
		*/
		virtual tyVolume_v1* GetVolume(
			const IPoint3 logicalCoordinates, 
			int &index) = 0;

		/*
		Converts a world-space position coordinate into a composite
		volume coordinate. The index component of the coordinate is
		the volume index (or -1 if the position coordinate is outside
		of all volumes), and the xyz component of the coordinate is
		the volume-local voxel XYZ coordinate that can be used to
		query per-voxel values of the indexed volume using the volume's
		scalar/vector accessor functions.
		*/
		struct VolumeCoordinate
		{
			int index = -1;
			Point3 xyz;
		};

		virtual VolumeCoordinate GetVolumeCoordinate(const Point3 pos) = 0;

		/*
		Helper function to convert temperature values from internal,
		normalized units to the specified unit type.
		*/
		enum TemperatureUnitType : int
		{
			normalized,
			celcius,
			fahrenheit,
			kelvin,
		};

		virtual float ConvertTemperature (
			const float temperature,
			const TemperatureUnitType units) = 0;
	};

	class tyVolumeObjectExt_v2 : public tyVolumeObjectExt_v1
	{
	public:
		/*
		Returns true if the user modified the underlying volumes since the
		last call to UpdateVolumes. If you are caching the returned data (ex:
		uploading the volumes to the GPU for rendering), calling this function
		tells you whether you need to re-cache the data since your last call 
		to UpdateVolumes, or whether your cached data is still up-to-date. 
		*/
		virtual bool VolumesChangedSinceLastUpdate() = 0;
	};

	class tyVolumeObjectExt_v3 : public tyVolumeObjectExt_v2
	{
	public:

		/*
		Returns a tyVolume by index (range: 0 - [NumVolumes()-1]).
		The interface retains ownership of these pointers and
		cleans them up in the call to ReleaseVolumes().
		*/
		virtual tyVolume_v2* GetVolume(const int index) = 0;

		/*
		Returns the tyVolume (if it exists, otherwise NULL) located
		at the specified logical coordinate point, as well as
		its interface index.
		The interface retains ownership of these pointers and
		cleans them up in the call to ReleaseVolumes().
		*/
		virtual tyVolume_v2* GetVolume(
			const IPoint3 logicalCoordinates,
			int& index) = 0;

		/*
		Returns the world-space raymarching step size specified
		by the corresponding volume display operator in tyFlow. 
		This is an optional parameter that 3rd-parties can use
		to match their raymarching step size with tyFlow's viewport
		volume display step size, when rendering volumes returned 
		by this interface.
		*/
		virtual float GetVolumeRaymarchingStepSize() = 0;

	};

	/*
	Helper functions to return the tyVolumeInterfaces from any given
	base object, if they're implemented. Developers should not
	assume that only tyFlow objects will return the volume interface,
	as other tyFlow-adjacent object classes may be extended to return
	this interface in the future (ex: tyCache). In other words, check
	all base objects for this interface, not just objects with a
	matching tyFlow ClassID.
	*/
	inline tyVolumeObjectExt_v1*
	GetTyVolumeInterface_v1 (BaseObject *obj)
	{
		return (tyVolumeObjectExt_v1*)obj->GetInterface(TYVOLUME_INTERFACE_V1);
	}

	inline tyVolumeObjectExt_v2*
	GetTyVolumeInterface_v2(BaseObject* obj)
	{
		return (tyVolumeObjectExt_v2*)obj->GetInterface(TYVOLUME_INTERFACE_V2);
	}

	inline tyVolumeObjectExt_v3*
		GetTyVolumeInterface_v3(BaseObject* obj)
	{
		return (tyVolumeObjectExt_v3*)obj->GetInterface(TYVOLUME_INTERFACE_V3);
	}
};
