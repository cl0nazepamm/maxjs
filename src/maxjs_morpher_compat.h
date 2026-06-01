#pragma once

#if __has_include(<imorpher.h>)
#include <imorpher.h>
#else
#include <WTypes.h>
#include <maxheap.h>
#include <SkinEngine/ISkinCodes.h>
#include <geom/point3.h>
#include <strbasic.h>
#include <tab.h>
#include <maxtypes.h>
#include <ref.h>
#include <iparamb2.h>
#include <geom/matrix3.h>

class INode;
class Matrix3;
class BitArray;
class Control;

#ifndef MR3_CLASS_ID
#define MR3_CLASS_ID Class_ID(0x17bb6854, 0xa5cba2a3)
#endif

#define I_MORPHER_INTERFACE_ID Interface_ID(0x1c037419, 0x40632fd1)
#define I_MORPHER_CHANNEL_INTERFACE_ID Interface_ID(0x1cef3b5e, 0x66097fd3)

#pragma warning(push)
#pragma warning(disable:4100)

class IMorpherChannel : public BaseInterface
{
public:
    virtual bool IsActive() const = 0;
    virtual const TCHAR* GetName(bool localized) = 0;
    virtual void SetName(const TCHAR* pName, bool localized) = 0;
    virtual int NumPoints() const = 0;
    virtual INode* GetTarget(int pTargetIndex) = 0;
    virtual int GetTargetCount() const = 0;
    virtual Point3 GetTargetPoint(int pTargetIndex, int pId) = 0;
    virtual bool SetTargetPercent(int pTargetIndex, double pTargetPercent) = 0;
    virtual double GetTargetPercent(int pTargetIndex) = 0;
    virtual Point3 GetPoint(int pId) = 0;
    virtual void SetPoint(int pId, Point3& pPoint) = 0;
    virtual Point3 GetDelta(int pId) = 0;
    virtual void SetDelta(int pId, Point3& pPoint) = 0;
    virtual double GetInitPercent() = 0;
    virtual double GetWeight(int pId) = 0;
    virtual void SetWeight(int pId, double pValue) = 0;
    virtual INode* GetConnection() = 0;
    virtual void SetConnection(INode* pNode) = 0;
    virtual Control* GetControl() = 0;
    virtual void Reset(bool active, bool modded, int numPoints) = 0;
    virtual bool IsProgressive() const = 0;
    virtual int NumTargets() const = 0;
    virtual bool GetBaseDeltas(Tab<Point3>& deltas) const = 0;
    virtual bool GetProgressiveTargetDeltas(int pTargetIndex, Tab<Point3>& deltas) const = 0;
    virtual bool GetAnimationKeysData(Tab<long>& vKeyTime, Tab<float>& vKeyValue) = 0;
};

class IMorpher : public BaseInterface
{
public:
    virtual void SetNumChannels(int ct) = 0;
    virtual int NumChannels() const = 0;
    virtual IMorpherChannel* GetChannel(int pChnlId, bool pDefaultInit = false) = 0;
    virtual bool AddProgressiveMorph(int pChnlId, INode* pShapeTarget) = 0;
    virtual void DeleteAllChannels() = 0;
    virtual void SetMaxInterface(IObjParam* pMaxInterface) = 0;
    virtual bool MakeCache(Object* pObj) = 0;
    virtual void NukeCache() = 0;
};

#pragma warning(pop)
#endif
